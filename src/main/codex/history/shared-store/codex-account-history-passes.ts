import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'node:path'
import { withSpan } from '../../../observability/tracer'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import {
  hasIncompleteHostCodexIndexHeal,
  isCodexAccountHistoryWorkStopping,
  requestHostCodexIndexHeal
} from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

type QueuedPass = { shared: boolean; pass: Promise<void> }

const BUSY_RETRY_MS = 5 * 60_000
// Retries start outside any pass's trace, so each is its own trace instead of nesting forever.
const inRootContext = AsyncLocalStorage.snapshot()

const INDEX_PENDING_DIR = (): string =>
  join(getOrcaUserDataPath(), 'codex-account-history', 'index-pending')

/**
 * Host account history passes, one at a time in request order (homes merging into one store at
 * once would race on its folders): a request joins only the latest one queued for that home with
 * the same mode. A home settled in a mode this run skips later passes in it.
 */
export class CodexAccountHistoryPasses {
  /**
   * Whether a busy home should still be shared, asked when its retry's pass starts: the setting
   * and the account may both have changed since it was found busy, or while the retry was queued.
   */
  constructor(private readonly isStillShared: (accountHome: string) => boolean) {}

  private readonly latest = new Map<string, QueuedPass>()
  private tail: Promise<void> = Promise.resolve()
  private readonly settledThisRun = new Map<string, boolean>()
  private readonly busyRetries = new Map<string, ReturnType<typeof setTimeout>>()
  // Retries whose pass is queued but not started: a launch doesn't wait behind other homes for one.
  private readonly queuedRetries = new Set<string>()
  private activePasses = 0
  // Homes whose left-behind rollouts still await a content check, checked once no pass runs.
  private readonly owedChecks = new Map<string, { accountHome: string }>()
  private checking = false
  private startedPasses = 0
  private readonly passProgress = {
    isPaused: (): boolean => this.activePasses > 0,
    started: (): number => this.startedPasses
  }

  run(
    accountHome: string,
    shared: boolean,
    options: { stillWanted?: () => boolean; fromRetry?: boolean } = {}
  ): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    if (shared && !options.fromRetry) {
      if (this.queuedRetries.has(key)) {
        // Its retry's pass is queued; a launch doesn't wait behind other homes for it.
        return Promise.resolve()
      }
      // The probe is cheap: a launch looks now (its Codexes may all have closed) instead of waiting
      // for the timer, which a still-busy result arms again.
      const timer = this.busyRetries.get(key)
      if (timer) {
        clearTimeout(timer)
        this.busyRetries.delete(key)
      }
    }
    const previous = this.latest.get(key)
    if (previous?.shared === shared) {
      return previous.pass
    }
    const pass = this.tail.then(async () => {
      if (options.fromRetry) {
        // Started: a launch now waits for it, since it may be moving the home's files.
        this.queuedRetries.delete(key)
      }
      if (options.stillWanted && !options.stillWanted()) {
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
    })
    this.tail = pass.catch(() => {})
    this.latest.set(key, { shared, pass })
    void pass.finally(() => {
      if (this.latest.get(key)?.pass === pass) {
        this.latest.delete(key)
      }
    })
    return pass
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
    try {
      if (!shared) {
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
      if (result === 'busy') {
        this.retryWhenIdle(key, accountHome)
      }
      return result
    } catch (error) {
      onWarning(error)
      return 'failed'
    }
  }

  // The account in use always has a Codex running at launch: retry until a moment none holds a lock.
  private retryWhenIdle(key: string, accountHome: string): void {
    if (this.busyRetries.has(key)) {
      return
    }
    const timer = inRootContext(() =>
      setTimeout(() => {
        this.busyRetries.delete(key)
        if (!isCodexAccountHistoryWorkStopping()) {
          this.queuedRetries.add(key)
          void this.run(accountHome, true, {
            fromRetry: true,
            stillWanted: () =>
              !isCodexAccountHistoryWorkStopping() && this.isStillShared(accountHome)
          })
            .finally(() => this.queuedRetries.delete(key))
            .catch(() => {})
        }
      }, BUSY_RETRY_MS)
    )
    timer.unref?.()
    this.busyRetries.set(key, timer)
  }

  // Hashing a large history must not delay a launch: a starting pass stops it after one file.
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
    void checkCodexHistoryLeftBehind({
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
