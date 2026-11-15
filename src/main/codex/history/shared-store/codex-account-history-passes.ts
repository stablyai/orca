import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { startHostCodexIndexHeal } from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

type QueuedPass = { shared: boolean; pass: Promise<void> }

/**
 * Host account history passes, in request order per home: a request joins only the latest one
 * queued for that home with the same mode. A home shared once this run skips later passes.
 */
export class CodexAccountHistoryPasses {
  private readonly latest = new Map<string, QueuedPass>()
  private readonly sharedThisRun = new Set<string>()

  run(accountHome: string, shared: boolean): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    const previous = this.latest.get(key)
    if (previous?.shared === shared) {
      return previous.pass
    }
    const pass = (previous?.pass ?? Promise.resolve()).then(() =>
      this.runPass(key, accountHome, shared)
    )
    this.latest.set(key, { shared, pass })
    void pass.finally(() => {
      if (this.latest.get(key)?.pass === pass) {
        this.latest.delete(key)
      }
    })
    return pass
  }

  private async runPass(key: string, accountHome: string, shared: boolean): Promise<void> {
    if (shared && this.sharedThisRun.has(key)) {
      return
    }
    this.sharedThisRun.delete(key)
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    try {
      if (!shared) {
        await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
        return
      }
      const indexPendingDir = join(getOrcaUserDataPath(), 'codex-account-history', 'index-pending')
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
        this.sharedThisRun.add(key)
        startHostCodexIndexHeal(indexPendingDir, storeHome)
      }
    } catch (error) {
      onWarning(error)
    }
  }
}
