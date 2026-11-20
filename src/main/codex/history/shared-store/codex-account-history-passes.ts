import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'node:path'
import { withSpan } from '../../../observability/tracer'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { checkThenCleanUpCodexHistory } from './codex-account-history-cleanup-sweep'
import {
  hasIncompleteHostCodexIndexHeal,
  isCodexAccountHistoryWorkStopping,
  requestHostCodexIndexHeal
} from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'
import {
  CodexHistoryImportRunner,
  type CodexHistoryImportSettings
} from '../import/codex-history-import-runner'

import { CodexHistoryPassRequests } from './codex-history-pass-queue'
import { WRITER_LOCKS } from './codex-thread-writer-locks'
import { isLinkedDirectory } from '../../../filesystem/merged-directory-link'

const BUSY_RETRY_MS = 5 * 60_000
// Retries start outside any pass's trace, so each is its own trace instead of nesting forever.
const inRootContext = AsyncLocalStorage.snapshot()

const INDEX_PENDING_DIR = (): string =>
  join(getOrcaUserDataPath(), 'codex-account-history', 'index-pending')

/**
 * Host account history passes, one at a time (homes merging into one store at once would race on
 * its folders), a launch's own ahead of background ones; the newest request for a home replaces
 * an older one still queued. A home settled in a mode this run skips later passes.
 */
export class CodexAccountHistoryPasses {
  /**
   * Whether a busy home should still be shared, asked when its retry's pass starts: the setting
   * and the account may both have changed since it was found busy, or while the retry was queued.
   */
  constructor(private readonly isStillShared: (accountHome: string) => boolean) {}

  private readonly requests = new CodexHistoryPassRequests()
  private readonly settledThisRun = new Map<string, boolean>()
  // When a home's lock folder last failed to link (another volume, a user's own link, a full
  // disk): a pass starts the helper again only after the busy retry's interval.
  private readonly lockFolderFailedAt = new Map<string, number>()
  private readonly busyRetries = new Map<string, ReturnType<typeof setTimeout>>()
  private activePasses = 0
  // Homes whose left-behind rollouts still await a content check, checked once no pass runs.
  private readonly owedChecks = new Map<string, { accountHome: string }>()
  private checking = false
  // When each import folder last finished a pass this run.
  private readonly imports = new CodexHistoryImportRunner({
    indexPendingDir: INDEX_PENDING_DIR,
    // Only publishing pauses the index heal: a frozen import folder must not hold it.
    publish: (job) =>
      this.requests.enqueue('host', async () => {
        this.activePasses += 1
        this.startedPasses += 1
        try {
          return await job()
        } finally {
          this.activePasses -= 1
        }
      }),
    waitForLaunches: () => this.requests.whenNoLaunchWaiting('host'),
    requestIndexHeal: () =>
      requestHostCodexIndexHeal(INDEX_PENDING_DIR(), getSystemCodexHomePath(), this.passProgress),
    imported: () => {
      requestHostCodexIndexHeal(INDEX_PENDING_DIR(), getSystemCodexHomePath(), this.passProgress)
      this.checkOwed()
    }
  })
  private startedPasses = 0
  private readonly passProgress = {
    isPaused: (): boolean => this.activePasses > 0,
    started: (): number => this.startedPasses
  }

  /** `forLaunch`: a launch waits on it, so it goes ahead of queued background passes. */
  run(
    accountHome: string,
    shared: boolean,
    options: { forLaunch?: boolean; stillWanted?: () => boolean } = {}
  ): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    if (shared && this.busyRetries.has(key) && !this.requests.has(key)) {
      // Found busy and nothing queued for it: its retry looks again within five minutes. A launch
      // doesn't pay for a probe (a PowerShell start on Windows) meanwhile.
      return Promise.resolve()
    }
    // A launch's own pass goes ahead of background ones, never behind a queued one.
    return this.requests.request(
      { queue: 'host', home: key, shared, forLaunch: options.forLaunch ?? false },
      async () => {
        if (options.stillWanted && !options.stillWanted()) {
          return
        }
        const failedAt = this.lockFolderFailedAt.get(key)
        if (shared && failedAt !== undefined && Date.now() - failedAt < BUSY_RETRY_MS) {
          return
        }
        if (this.settledThisRun.get(key) === shared) {
          // Moves are done; only index work a stopped or failed heal left behind is retried.
          if (hasIncompleteHostCodexIndexHeal(INDEX_PENDING_DIR())) {
            requestHostCodexIndexHeal(
              INDEX_PENDING_DIR(),
              getSystemCodexHomePath(),
              this.passProgress
            )
          }
          return
        }
        this.activePasses += 1
        this.startedPasses += 1
        try {
          await this.runPass(key, accountHome, shared)
        } finally {
          this.activePasses -= 1
        }
        // Index once no pass is moving files.
        requestHostCodexIndexHeal(INDEX_PENDING_DIR(), getSystemCodexHomePath(), this.passProgress)
        this.checkOwed()
      }
    )
  }

  /** Copies the import folder's conversations that ~/.codex lacks into it (see the runner). */
  importHistory(
    getSettings: () => CodexHistoryImportSettings,
    options: { settingChanged?: boolean } = {}
  ): Promise<void> {
    return this.imports.importHistory(getSettings, options)
  }

  private async runPass(key: string, accountHome: string, shared: boolean): Promise<void> {
    this.settledThisRun.delete(key)
    // Recorded in the trace log, so a home that never moves shows why.
    await withSpan('codex-account-history.pass', async (span) => {
      span.setAttribute('account', basename(dirname(accountHome)))
      span.setAttribute('outcome', await this.passOutcome(key, accountHome, shared))
    })
  }

  private async passOutcome(key: string, accountHome: string, shared: boolean): Promise<string> {
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    // Whatever this pass settles, an older busy retry no longer speaks for the home.
    this.cancelRetry(key)
    try {
      if (!shared) {
        this.lockFolderFailedAt.delete(key)
        if (await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })) {
          this.settledThisRun.set(key, false)
          return 'unshared'
        }
        return 'incomplete'
      }
      const result = await shareCodexAccountHistory({
        accountHome,
        storeHome,
        // A user's own CODEX_SQLITE_HOME already points every home's databases at the store.
        sqliteHome: process.env.CODEX_SQLITE_HOME?.trim() ? null : storeHome,
        indexPendingDir: INDEX_PENDING_DIR(),
        platform: process.platform,
        onWarning
      })
      if (result === 'shared') {
        this.settledThisRun.set(key, true)
      }
      if (result === 'shared' || result === 'incomplete') {
        this.owedChecks.set(key, { accountHome })
      }
      if (result === 'busy' || result === 'no-helper') {
        this.retryWhenIdle(key, accountHome)
      }
      // Only a lock folder that couldn't link starts the helper again each pass; a history folder
      // that failed (an antivirus handle, say) is cheap to retry.
      if (
        result === 'private' &&
        !(await isLinkedDirectory(join(accountHome, WRITER_LOCKS), join(storeHome, WRITER_LOCKS)))
      ) {
        this.lockFolderFailedAt.set(key, Date.now())
      }
      return result
    } catch (error) {
      onWarning(error)
      return 'failed'
    }
  }

  private cancelRetry(key: string): void {
    clearTimeout(this.busyRetries.get(key))
    this.busyRetries.delete(key)
  }

  // The account in use always has a Codex running at launch: retry until a moment none holds a lock.
  private retryWhenIdle(key: string, accountHome: string): void {
    if (this.busyRetries.has(key)) {
      return
    }
    const timer = inRootContext(() =>
      setTimeout(() => {
        this.busyRetries.delete(key)
        // A request queued since (an unshare above all) decides instead; the retry would replace it.
        if (
          !isCodexAccountHistoryWorkStopping() &&
          this.isStillShared(accountHome) &&
          !this.requests.has(key)
        ) {
          void this.run(accountHome, true, {
            stillWanted: () =>
              !isCodexAccountHistoryWorkStopping() && this.isStillShared(accountHome)
          }).catch(() => {})
        }
      }, BUSY_RETRY_MS)
    )
    timer.unref?.()
    this.busyRetries.set(key, timer)
  }

  // Hashing and deleting must not delay a launch: a starting pass stops them after one file.
  private checkOwed(): void {
    if (this.checking || this.activePasses > 0 || isCodexAccountHistoryWorkStopping()) {
      return
    }
    const next = this.owedChecks.entries().next()
    if (next.done) {
      return
    }
    const [key, request] = next.value
    // A pass that finished meanwhile owes a fresh check; only this run's request is settled.
    const settle = (): void => {
      if (this.owedChecks.get(key) === request) {
        this.owedChecks.delete(key)
      }
    }
    this.checking = true
    void checkThenCleanUpCodexHistory({
      accountHome: request.accountHome,
      storeHome: getSystemCodexHomePath(),
      shouldStop: () => this.activePasses > 0 || isCodexAccountHistoryWorkStopping()
    })
      .then((finished) => {
        if (finished) {
          settle()
        }
      })
      .catch((error: unknown) => {
        settle()
        console.warn('[codex-account-history] Checking left-behind history failed:', error)
      })
      .finally(() => {
        this.checking = false
        this.checkOwed()
      })
  }
}
