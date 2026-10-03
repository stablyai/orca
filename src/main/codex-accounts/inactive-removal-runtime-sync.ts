import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  CodexManagedAccount,
  CodexManagedAccountRuntimeSelection
} from '../../shared/managed-account-types'
import {
  normalizeCodexRuntimeSelection,
  pruneInvalidCodexRuntimeSelection
} from './runtime-selection'

export function canSkipCodexRemovalRuntimeSync(
  settings: GlobalSettings,
  nextAccounts: CodexManagedAccount[],
  nextSelection: CodexManagedAccountRuntimeSelection,
  readSelectedHostHome: () => string | null
): boolean {
  const previous = normalizeCodexRuntimeSelection(settings)
  const next = pruneInvalidCodexRuntimeSelection(nextSelection, nextAccounts)
  if (!previous.host || JSON.stringify(previous) !== JSON.stringify(next)) {
    return false
  }
  const active = nextAccounts.find((account) => account.id === previous.host)
  return (
    active !== undefined &&
    active.managedHomeRuntime !== 'wsl' &&
    readSelectedHostHome() === active.managedHomePath
  )
}
