import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import {
  hasIncompleteHostCodexIndexHeal,
  requestHostCodexIndexHeal
} from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

type QueuedPass = { shared: boolean; pass: Promise<void> }

const INDEX_PENDING_DIR = (): string =>
  join(getOrcaUserDataPath(), 'codex-account-history', 'index-pending')

/**
 * Host account history passes, one at a time in request order (homes merging into one store at
 * once would race on its folders): a request joins only the latest one queued for that home with
 * the same mode. A home settled in a mode this run skips later passes in it.
 */
export class CodexAccountHistoryPasses {
  private readonly latest = new Map<string, QueuedPass>()
  private tail: Promise<void> = Promise.resolve()
  private readonly settledThisRun = new Map<string, boolean>()
  private activePasses = 0
  private startedPasses = 0
  private readonly passProgress = {
    isPaused: (): boolean => this.activePasses > 0,
    started: (): number => this.startedPasses
  }

  run(accountHome: string, shared: boolean): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    const previous = this.latest.get(key)
    if (previous?.shared === shared) {
      return previous.pass
    }
    const pass = this.tail.then(async () => {
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
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    try {
      if (!shared) {
        if (await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })) {
          this.settledThisRun.set(key, false)
        }
        return
      }
      const indexPendingDir = INDEX_PENDING_DIR()
      const result = await shareCodexAccountHistory({
        accountHome,
        storeHome,
        // A user's own CODEX_SQLITE_HOME already points every home's databases at the store.
        sqliteHome: process.env.CODEX_SQLITE_HOME?.trim() ? null : storeHome,
        indexPendingDir,
        platform: process.platform,
        onWarning
      })
      if (result === 'shared') {
        this.settledThisRun.set(key, true)
      }
    } catch (error) {
      onWarning(error)
    }
  }
}
