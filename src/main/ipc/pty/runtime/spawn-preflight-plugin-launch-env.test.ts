import { describe, expect, it, vi } from 'vitest'
import { applyAgentLaunchPluginHook } from '../spawn/spawn-agent-launch-plugin-hook'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState } from './spawn-state'
import { makeRuntimePtySpawnTestDeps } from './spawn-preflight-test-deps-fixture'

vi.mock('../../../plugins/hooks/plugin-hook-dispatch', () => ({
  pluginHookWanted: () => true,
  runPluginHook: async (_hook: string, _schema: unknown, payload: { command: string }) => ({
    command: payload.command,
    env: { CLAUDE_CONFIG_DIR: '/plugin/account', PLUGIN_FLAG: '1' }
  })
}))

describe('agent.launch.before env and the host account environment', () => {
  it("keeps the hook's env over the selected account's env, and the host's own ORCA_ keys", async () => {
    const deps = {
      ...makeRuntimePtySpawnTestDeps(),
      prepareClaudeAuth: async () => ({
        configDir: '/host/account',
        provenance: 'test',
        envPatch: {
          CLAUDE_CONFIG_DIR: '/host/account',
          ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/host/account',
          ORCA_CLAUDE_PROFILE_POINTER: '/host/pointer'
        }
      })
    }
    const ctx = createRuntimePtySpawnState(deps, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      command: 'claude',
      launchAgent: 'claude'
    })
    try {
      const launched = await applyAgentLaunchPluginHook(ctx.args, undefined)
      ctx.args = launched.args
      ctx.pluginLaunchEnv = launched.pluginEnv
      await prepareRuntimePtySpawn(ctx)
    } finally {
      ctx.finishTerminalInstall()
    }
    expect(ctx.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/plugin/account',
      PLUGIN_FLAG: '1',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/host/account',
      ORCA_CLAUDE_PROFILE_POINTER: '/host/pointer'
    })
  })
})
