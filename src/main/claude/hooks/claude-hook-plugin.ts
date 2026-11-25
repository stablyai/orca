import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { CLAUDE_HOOK_PLUGIN_NAME } from '../../../shared/agent-hook-listener/providers/claude/claude-hook-plugin'
import type { HooksConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import { writeHooksJsonAsync } from '../../agent-hooks/installation/configuration/hooks-json-write-async'

const PLUGIN_MANIFEST = {
  name: CLAUDE_HOOK_PLUGIN_NAME,
  version: '1.0.0',
  description: 'Orca agent status hooks for Claude config folders Orca does not manage',
  author: { name: 'stablyai' },
  license: 'MIT'
}

// One write at a time, and only the latest request waits: a quick on/off toggle lands in order and a burst costs one pass.
let running = false
let pending: { label: string; run: () => Promise<void> } | null = null

function enqueue(label: string, run: () => Promise<void>): void {
  pending = { label, run }
  if (running) {
    return
  }
  running = true
  void (async () => {
    while (pending) {
      const next: { label: string; run: () => Promise<void> } = pending
      pending = null
      await next.run().catch((error: unknown) => {
        console.warn(`[agent-hooks] Claude hook plugin ${next.label} failed`, error)
      })
    }
    running = false
  })()
}

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
  enqueue('publish', async () => {
    await writeHooksJsonAsync(join(root, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST)
    await writeHooksJsonAsync(join(root, 'hooks', 'hooks.json'), { hooks: buildHooks() ?? {} })
  })
}

export function removeClaudeHookPlugin(agent: AgentHookInstallStatus['agent']): void {
  if (agent === 'claude') {
    const root = getClaudeHookPluginDir(getAppEnvironment().getPath('userData'))
    enqueue('removal', () => rm(root, { recursive: true, force: true }))
  }
}
