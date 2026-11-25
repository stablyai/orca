import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { CLAUDE_HOOK_PLUGIN_NAME } from '../../../shared/agent-hook-listener/providers/claude/claude-hook-plugin'
import type { HooksConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import { writeHooksJson } from '../../agent-hooks/installation/configuration/hooks-json-write'

/** Fixed path, so a pane's env stays valid while the hook set changes underneath it. */
export function getClaudeHookPluginDir(userDataPath: string): string {
  return join(userDataPath, 'claude-hook-plugin', CLAUDE_HOOK_PLUGIN_NAME)
}

/** A Claude started with a config folder Orca never hooked loads these through its pane's shell function. */
export function publishClaudeHookPlugin(
  agent: AgentHookInstallStatus['agent'],
  buildHooks: () => HooksConfig['hooks']
): void {
  if (agent !== 'claude') {
    return
  }
  const root = getClaudeHookPluginDir(getAppEnvironment().getPath('userData'))
  writeHooksJson(join(root, '.claude-plugin', 'plugin.json'), {
    name: CLAUDE_HOOK_PLUGIN_NAME,
    version: '1.0.0',
    description: 'Orca agent status hooks for Claude config folders Orca does not manage',
    author: { name: 'stablyai' },
    license: 'MIT'
  })
  writeHooksJson(join(root, 'hooks', 'hooks.json'), { hooks: buildHooks() ?? {} })
}

export function removeClaudeHookPlugin(agent: AgentHookInstallStatus['agent']): void {
  if (agent === 'claude') {
    rmSync(getClaudeHookPluginDir(getAppEnvironment().getPath('userData')), {
      recursive: true,
      force: true
    })
  }
}
