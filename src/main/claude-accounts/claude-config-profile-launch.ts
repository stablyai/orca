import { mkdir } from 'node:fs/promises'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { claudeHookService } from '../claude/hook-service'
import { resolveClaudeCommand } from '../codex-cli/command'
import { claudeConfigProfileFolderFailed } from './claude-profile-launch-errors'

type ProfileLaunchSettings = Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>

/** The folder belongs to the user: create it when missing and merge Orca's status hooks, never sync settings into it. */
export async function prepareClaudeConfigProfileLaunch(
  configDir: string,
  settings: ProfileLaunchSettings | undefined
): Promise<void> {
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    // Starting without the folder would leave Claude to fail later or write somewhere unexpected.
    throw claudeConfigProfileFolderFailed(configDir, error)
  }
  if (!settings || !isAgentStatusHooksEnabledForAgent(settings, 'claude')) {
    return
  }
  try {
    await installProfileStatusHooks(configDir)
  } catch (error) {
    // Hooks only feed the status indicator; the launch must still start.
    console.warn('[claude-profile] Could not add status hooks to the profile folder:', error)
  }
}

/** Install only when missing, so a launch does not rewrite the user's settings.json each time. */
async function installProfileStatusHooks(configDir: string): Promise<void> {
  const claudeVersion = (await probeRecentClaudeCliVersion(resolveClaudeCommand())) ?? undefined
  if (claudeHookService.getStatus({ configDir, claudeVersion }).state === 'installed') {
    return
  }
  const status = claudeHookService.install({ configDir, claudeVersion })
  if (status.state !== 'installed') {
    console.warn('[claude-profile] Status hooks were not added to the profile folder:', status)
  }
}
