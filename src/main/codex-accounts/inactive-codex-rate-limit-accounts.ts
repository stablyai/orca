import type { GlobalSettings } from '../../shared/types'
import { normalizeCodexRuntimeSelection } from './runtime-selection'

export type InactiveCodexRateLimitAccount = {
  id: string
  managedHomePath: string
}

type InactiveCodexRateLimitAccountSettings = Pick<
  GlobalSettings,
  | 'activeCodexManagedAccountId'
  | 'activeCodexManagedAccountIdsByRuntime'
  | 'codexManagedAccounts'
  | 'codexUseDefaultConfigDir'
>

export function getInactiveCodexRateLimitAccounts(
  settings: InactiveCodexRateLimitAccountSettings
): InactiveCodexRateLimitAccount[] {
  const selection = normalizeCodexRuntimeSelection(settings)
  const activeIds = new Set(
    [selection.host, ...Object.values(selection.wsl)].filter((id): id is string => Boolean(id))
  )
  const hostManagedHomesPaused = settings.codexUseDefaultConfigDir === true

  return settings.codexManagedAccounts
    .filter((account) => !activeIds.has(account.id))
    .filter((account) => {
      if (!hostManagedHomesPaused) {
        return true
      }
      // Why: default-home mode exists to stop host managed homes from refreshing
      // tokens behind the user's ~/.codex session; WSL homes are a separate runtime.
      return account.managedHomeRuntime === 'wsl'
    })
    .map((account) => ({ id: account.id, managedHomePath: account.managedHomePath }))
}
