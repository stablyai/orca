import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from '../../shared/tui-agent-permissions'

/**
 * The Agent Permissions setting as app-server argv.
 *
 * Derived per acquisition from the resolved launch arguments, never from the free-text Arguments
 * field: app-server takes a narrower option set than the interactive CLI and the two are versioned
 * apart, so the only thing read out of that field is the posture the toggle stores in it. An
 * untouched profile resolves to the default Orca ships, which is the bypass flag.
 */
export function codexStructuredPermissionArgsForSettings(
  settings: Partial<Pick<GlobalSettings, 'agentDefaultArgs'>> | null | undefined
): string[] {
  const bypassArg = YOLO_TUI_AGENT_ARGS.codex
  return bypassArg !== undefined &&
    resolvedTuiAgentArgsBypassPermissions('codex', settings?.agentDefaultArgs)
    ? [bypassArg]
    : []
}
