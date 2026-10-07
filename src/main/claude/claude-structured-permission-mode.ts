import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentLaunchProfileSettings } from '../../shared/tui-agent-launch-defaults'
import { resolveAgentPermissionPosture } from '../../shared/tui-agent-permission-args'
import { resolveLocalAgentLaunchTarget } from '../../shared/windows-terminal-shell'

/**
 * The Agent Permissions setting as the SDK's own permission mode.
 *
 * Read per acquisition — like the environment overlay and the auth policy beside it — rather than
 * latched into the session record: the setting is the one copy of this fact, so nothing can
 * disagree with it and a failed restore cannot silently downgrade a session to prompting.
 *
 * Reads the agent's typed permission mode — the same field a terminal launch turns into its
 * flag — plus a bypass flag typed into Arguments, which a terminal launch also honours. The rest
 * of the arguments string is a terminal concern this path does not interpret.
 */
export function claudeStructuredPermissionModeForSettings(
  settings:
    | (AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>)
    | null
    | undefined
): PermissionMode {
  return resolveAgentPermissionPosture(
    'claude',
    settings,
    resolveLocalAgentLaunchTarget(process.platform, settings?.terminalWindowsShell)
  ).effectiveBypass
    ? 'bypassPermissions'
    : 'default'
}
