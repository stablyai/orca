import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'

/** WSL hosts hold a per-distro memory budget; a retire there costs the next scan ~1.5x on a big history. */
export const WSL_HOST_SESSION_SCANNER_IDLE_TIMEOUT_MS = 3 * 60_000

/** SSH hosts keep the 10-minute default: they have no memory budget to justify slower scans. */
export function orcadSessionScannerIdleTimeoutMs(
  isWslHost: () => boolean = isWslHostOrcadProcess
): number | null {
  return isWslHost() ? WSL_HOST_SESSION_SCANNER_IDLE_TIMEOUT_MS : null
}

export async function configureOrcadSessionScannerIdleTimeout(): Promise<void> {
  const timeoutMs = orcadSessionScannerIdleTimeoutMs()
  if (timeoutMs !== null) {
    const { setAiVaultServiceIdleTimeoutMs } =
      await import('../ai-vault/session-scanner-service-spawn')
    setAiVaultServiceIdleTimeoutMs(timeoutMs)
  }
}
