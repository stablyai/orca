import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'

/** Whether Orca may link Codex sessions between account homes and ~/.codex; absent means on. */
export function isCodexHistorySharedAcrossAccounts(
  settings: Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts'>,
  account?: { privateHistory?: boolean }
): boolean {
  return account?.privateHistory !== true && settings.codexShareHistoryAcrossAccounts !== false
}

export function isCodexHistorySharedForHome(
  settings: Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts' | 'codexManagedAccounts'>,
  home: string,
  wslDistro?: string
): boolean {
  const key = normalizeRuntimePathForComparison(home)
  const account = settings.codexManagedAccounts.find(
    (entry) =>
      normalizeRuntimePathForComparison(entry.managedHomePath) === key ||
      (wslDistro &&
        entry.managedHomeRuntime === 'wsl' &&
        entry.wslDistro?.toLowerCase() === wslDistro.toLowerCase() &&
        entry.wslLinuxHomePath &&
        normalizeRuntimePathForComparison(entry.wslLinuxHomePath) === key)
  )
  return isCodexHistorySharedAcrossAccounts(settings, account)
}
