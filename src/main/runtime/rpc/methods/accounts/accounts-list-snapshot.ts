import type { OrcaRuntimeService } from '../../../orca-runtime'

export function accountsListSnapshot(runtime: OrcaRuntimeService) {
  const snapshot = runtime.getAccountsSnapshot()
  const settings = runtime.requireStore().getSettings()
  return {
    ...snapshot,
    claude: { ...snapshot.claude, dynamic: settings.claudeDynamicAccountLaunch === true },
    codex: { ...snapshot.codex, dynamic: settings.codexDynamicAccountLaunch === true }
  }
}
