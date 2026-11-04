import { mkdir } from 'node:fs/promises'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { claudeHookService } from '../claude/hook-service'
import { resolveClaudeCommand } from '../codex-cli/command'

type ProfileLaunchSettings = Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>

/** The folder belongs to the user: create it when missing and merge Orca's status hooks, never sync settings into it. */
export async function prepareClaudeConfigProfileLaunch(
  configDir: string,
  settings: ProfileLaunchSettings | undefined
): Promise<void> {
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    if (!settings || !isAgentStatusHooksEnabledForAgent(settings, 'claude')) {
      return
    }
    const claudeVersion = (await probeRecentClaudeCliVersion(resolveClaudeCommand())) ?? undefined
    if (claudeHookService.getStatus({ configDir, claudeVersion }).state === 'installed') {
      return
    }
    const status = claudeHookService.install({ configDir, claudeVersion })
    if (status.state !== 'installed') {
      console.warn('[claude-profile] Status hooks were not added to the profile folder:', status)
    }
  } catch (error) {
    // Hooks only feed the status indicator; the launch must still start.
    console.warn('[claude-profile] Could not prepare the Claude profile folder:', error)
  }
}
