import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'

/** Bypass runs tools immediately. Anything else turns on the SDK sandbox and Auto-review. */
export function cursorStructuredToolGateForSettings(
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined
): { sandbox: boolean; autoReview: boolean } {
  const bypass = resolvedTuiAgentArgsBypassPermissions('cursor', settings, process.platform)
  return { sandbox: !bypass, autoReview: !bypass }
}
