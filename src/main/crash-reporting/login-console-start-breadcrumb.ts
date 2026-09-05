import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

/**
 * Records the Windows sign-in consoles that closed without ever running their
 * payload.
 *
 * Why a breadcrumb and not a rejection: `start /wait` does not relay the
 * payload's exit code, so a PowerShell host that dies before the login script
 * runs closes the wrapper with 0 and the sign-in is reported as finished. The
 * caller then fails on missing credentials — an error that names neither
 * PowerShell nor the console — and nothing in the logs contradicts it. This
 * leaves that contradiction on the record for the next field report.
 */
export function recordLoginConsoleStartIfMissed(
  interactiveLogin: Pick<WindowsHostInteractiveLoginSpawn, 'hasRelayedPid'> | null | undefined,
  provider: 'claude' | 'codex'
): void {
  if (!interactiveLogin?.hasRelayedPid || interactiveLogin.hasRelayedPid()) {
    return
  }
  recordDurableCrashBreadcrumb('login_console_never_started', { provider })
}
