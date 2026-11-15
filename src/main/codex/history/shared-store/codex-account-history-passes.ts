import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { startHostCodexAccountIndexHeal } from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'

/** One history link pass per host account home; a launch joins one already running. */
export class CodexAccountHistoryPasses {
  private readonly running = new Map<string, Promise<void>>()

  /** Before Codex starts in the home; after the first run it is a few lstat calls. */
  run(accountHome: string, shared: boolean): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    const existing = this.running.get(key)
    if (existing) {
      return existing
    }
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    const pass = (
      shared
        ? shareCodexAccountHistory({
            accountHome,
            storeHome,
            platform: process.platform,
            onWarning
          }).then((result) => {
            if (result === 'shared') {
              startHostCodexAccountIndexHeal(accountHome, storeHome)
            }
          })
        : unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
    )
      .catch(onWarning)
      .finally(() => this.running.delete(key))
    this.running.set(key, pass)
    return pass
  }
}
