import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

// A clean wrapper exit alone does not prove that PowerShell ran the login payload.
export function recordLoginConsoleStartIfMissed(
  interactiveLogin: Pick<WindowsHostInteractiveLoginSpawn, 'hasRelayedPid'> | null | undefined,
  provider: 'claude' | 'codex'
): boolean {
  if (!interactiveLogin?.hasRelayedPid || interactiveLogin.hasRelayedPid()) {
    return false
  }
  recordDurableCrashBreadcrumb('login_console_never_started', { provider })
  return true
}
