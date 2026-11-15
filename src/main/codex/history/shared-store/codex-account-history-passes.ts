import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { startHostCodexAccountIndexHeal } from './codex-account-history-index'
import {
  isCodexAccountHistoryLinked,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'

/**
 * Host account history passes, one at a time: two homes moving the same file name into the
 * store at once could otherwise both see it missing. A request joins an identical queued one.
 */
export class CodexAccountHistoryPasses {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly queued = new Map<string, Promise<boolean>>()

  /** Resolves to whether the home's history now lives in the store. */
  run(accountHome: string, shared: boolean): Promise<boolean> {
    const key = `${shared}\0${normalizeRuntimePathForComparison(accountHome)}`
    const existing = this.queued.get(key)
    if (existing) {
      return existing
    }
    const pass = this.tail
      .then(() => this.runPass(accountHome, shared))
      .finally(() => this.queued.delete(key))
    this.tail = pass.catch(() => {})
    this.queued.set(key, pass)
    return pass
  }

  private async runPass(accountHome: string, shared: boolean): Promise<boolean> {
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    try {
      if (!shared) {
        await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
        return false
      }
      const result = await shareCodexAccountHistory({
        accountHome,
        storeHome,
        platform: process.platform,
        onWarning
      })
      if (result === 'shared') {
        startHostCodexAccountIndexHeal(accountHome, storeHome)
      }
      return result === 'shared'
    } catch (error) {
      onWarning(error)
      return isCodexAccountHistoryLinked(accountHome, storeHome).catch(() => false)
    }
  }
}
