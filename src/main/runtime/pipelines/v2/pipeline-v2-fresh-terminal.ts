import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { AgentLaunchProfileSettings } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  resolveStartupShell,
  tokenizeStartupCommand
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'

export type PipelineV2LaunchSettings = AgentLaunchProfileSettings &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>

export function assertPipelineV2FreshTerminal(
  agent: TuiAgent,
  settings: PipelineV2LaunchSettings,
  platform: NodeJS.Platform = process.platform
) {
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  )
  const selectors = new Set([
    'resume',
    'fork',
    '--resume',
    '--continue',
    '--resume-id',
    '--session',
    '--conversation',
    '--fork',
    '--fork-session'
  ])
  if (agent === 'claude' || agent === 'claude-agent-teams') {
    selectors.add('-r')
    selectors.add('-c')
  }
  for (const value of [settings.agentDefaultArgs?.[agent], settings.agentCmdOverrides?.[agent]]) {
    if (!value?.trim()) {
      continue
    }
    const parsed = tokenizeStartupCommand(value, shell)
    if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
      throw new Error('pipeline_terminal_launch_unverifiable')
    }
    if (parsed.tokens.some((token) => selectors.has(token.split('=', 1)[0]))) {
      throw new Error('pipeline_fresh_session_required')
    }
  }
}
