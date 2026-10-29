import { delimiter } from 'node:path'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getClaudeAgentViewService } from '../../../claude/agent-view-service'
import type { BuildPtyHostEnvOptions } from './types'

export function applyClaudeAgentViewEnv(
  env: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  const previous =
    env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR ?? process.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (previous) {
    const paths = env.CLAUDE_CODE_PLUGIN_DIRS ?? process.env.CLAUDE_CODE_PLUGIN_DIRS
    if (paths?.split(delimiter).includes(previous)) {
      const remaining = paths.split(delimiter).filter((path) => path !== previous)
      // An empty override is needed only to strip an inherited Orca path merged later by a daemon.
      env.CLAUDE_CODE_PLUGIN_DIRS = remaining.join(delimiter)
    }
  }
  delete env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  delete env.ORCA_CLAUDE_CONFIG_DIR
  if (
    !opts.agentStatusHooksEnabled ||
    opts.claudeSubagentNavigationEnabled === false ||
    !isTuiAgentEnabled('claude', opts.disabledTuiAgents) ||
    opts.isWsl
  ) {
    return
  }
  const cached = getClaudeAgentViewService(opts.userDataPath).read(env.CLAUDE_CONFIG_DIR)
  if (!cached) {
    return
  }
  const paths =
    (env.CLAUDE_CODE_PLUGIN_DIRS ?? process.env.CLAUDE_CODE_PLUGIN_DIRS)
      ?.split(delimiter)
      .filter(Boolean) ?? []
  if (!paths.includes(cached.pluginDir)) {
    paths.push(cached.pluginDir)
  }
  env.CLAUDE_CODE_PLUGIN_DIRS = paths.join(delimiter)
  env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR = cached.pluginDir
  env.ORCA_CLAUDE_CONFIG_DIR = cached.configDir
}
