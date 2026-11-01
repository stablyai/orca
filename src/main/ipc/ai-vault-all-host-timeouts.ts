import type { RuntimeAiVaultHostInfo } from './ai-vault-runtime-scan'

// Per-leg bounds for the all-hosts fan-outs, so one slow host cannot hold a merge open.
export const AI_VAULT_ALL_HOST_TIMEOUT_MS = {
  runtimeScan: 3_000,
  // SSH/tunneled scans walk large remote homes; the shorter local budget hid healthy hosts.
  sshTunneledRuntimeScan: 15_000,
  // Indexed search shares the connection with scans, so use the same SSH budget.
  search: 15_000
} as const

export function allHostsRuntimeScanTimeoutMs(
  hostInfo: Pick<RuntimeAiVaultHostInfo, 'connectionDependency'>
): number {
  return hostInfo.connectionDependency === 'ssh-tunnel'
    ? AI_VAULT_ALL_HOST_TIMEOUT_MS.sshTunneledRuntimeScan
    : AI_VAULT_ALL_HOST_TIMEOUT_MS.runtimeScan
}
