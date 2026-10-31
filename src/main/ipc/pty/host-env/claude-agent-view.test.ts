import { delimiter } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyClaudeAgentViewEnv } from './claude-agent-view'
import type { BuildPtyHostEnvOptions } from './types'

const read = vi.hoisted(() => vi.fn())
vi.mock('../../../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ read })
}))

const options: BuildPtyHostEnvOptions = {
  userDataPath: '/orca',
  isPackaged: false,
  selectedCodexHomePath: null,
  agentStatusHooksEnabled: true
}

afterEach(() => {
  vi.unstubAllEnvs()
  read.mockReset()
})

it.each([undefined, '', 'user-plugin'])(
  'leaves plugin environment unchanged when disabled: %j',
  (value) => {
    vi.stubEnv('CLAUDE_CODE_PLUGIN_DIRS', 'inherited-user-plugin')
    vi.stubEnv('ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR', undefined)
    const env: Record<string, string> =
      value === undefined ? {} : { CLAUDE_CODE_PLUGIN_DIRS: value }
    const original = { ...env }
    for (let pane = 0; pane < 100; pane++) {
      applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: false })
    }
    expect(env).toEqual(original)
    expect(read).not.toHaveBeenCalled()
  }
)

it.each([undefined, true])(
  'uses the cache and preserves user plugin paths when enabled: %j',
  (enabled) => {
    vi.stubEnv('CLAUDE_CODE_PLUGIN_DIRS', undefined)
    vi.stubEnv('ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR', undefined)
    read.mockReturnValue({ pluginDir: '/orca/plugin', configDir: '/claude-profile' })
    for (let pane = 0; pane < 100; pane++) {
      const env = {
        CLAUDE_CONFIG_DIR: '/claude-profile',
        CLAUDE_CODE_PLUGIN_DIRS: `first${delimiter}second`
      }
      applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: enabled })
      expect(env).toMatchObject({
        CLAUDE_CODE_PLUGIN_DIRS: `first${delimiter}second${delimiter}/orca/plugin`,
        ORCA_CLAUDE_CONFIG_DIR: '/claude-profile'
      })
    }
    expect(read).toHaveBeenCalledTimes(100)
  }
)

it('strips only a previously inherited Orca path when disabled', () => {
  vi.stubEnv('ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR', '/orca/previous')
  vi.stubEnv('CLAUDE_CODE_PLUGIN_DIRS', `/user/plugin${delimiter}/orca/previous`)
  const env = {}
  applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: false })
  expect(env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '/user/plugin' })
})
