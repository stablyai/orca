import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../shared/tui-agent-config'

const applyAgentWorkspaceTrust = vi.hoisted(() =>
  vi.fn<(preset: string, path: string, context: unknown) => Promise<object>>(async () => ({}))
)
vi.mock('./agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))

import { applyAgentWorkspaceTrustToSpawn } from './agent-workspace-trust-spawn'

const store = {
  getFolderWorkspace: (id: string) => (id === 'fw-1' ? { folderPath: '/notes' } : undefined)
}

function spawnArgs(overrides: Partial<Parameters<typeof applyAgentWorkspaceTrustToSpawn>[0]>) {
  return {
    launchAgent: 'claude',
    worktreeId: 'repo-1::/repo/wt',
    cwd: undefined,
    store,
    isFreshLaunch: true,
    settings: { agentWorkspaceTrustEnabled: true },
    env: { CLAUDE_CONFIG_DIR: '/cfg' },
    claudeAuth: null,
    wslDistro: null,
    connectionId: null,
    codexHome: '/orca/codex-home',
    spawnOptions: {},
    ...overrides
  }
}

const PRESET_AGENTS = Object.keys(TUI_AGENT_CONFIG)
  .filter(isTuiAgent)
  .filter((agent) => TUI_AGENT_CONFIG[agent].preflightTrust)

beforeEach(() => {
  applyAgentWorkspaceTrust.mockClear()
})

describe('applyAgentWorkspaceTrustToSpawn', () => {
  it('covers both Claude launch modes and every other preset agent', () => {
    expect(PRESET_AGENTS).toEqual(
      expect.arrayContaining([
        'claude',
        'claude-agent-teams',
        'codex',
        'cursor',
        'copilot',
        'qoder',
        'qoder-cn',
        'antigravity'
      ])
    )
    expect(TUI_AGENT_CONFIG['claude-agent-teams'].preflightTrust).toBe('claude')
  })

  describe.each(PRESET_AGENTS)('%s', (agent) => {
    const preset = TUI_AGENT_CONFIG[agent].preflightTrust

    it.each([
      ['a linked worktree', 'repo-1::/repo/wt', '/repo/wt'],
      ['a main checkout', 'repo-1::/repo', '/repo'],
      [
        'a folder repo workspace',
        'repo-2::/folder::workspace:0f8fad5b-d9cb-469f-a165-70867728950e',
        '/folder'
      ],
      ['a folder workspace', 'folder:fw-1', '/notes']
    ])('trusts %s', async (_label, worktreeId, expectedPath) => {
      await applyAgentWorkspaceTrustToSpawn(spawnArgs({ launchAgent: agent, worktreeId }))
      expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(preset, expectedPath, {
        env: { CLAUDE_CONFIG_DIR: '/cfg' },
        claudeAuth: null,
        wslDistro: null,
        connectionId: null,
        codexHome: '/orca/codex-home'
      })
    })

    it('does nothing with the setting off', () => {
      expect(
        applyAgentWorkspaceTrustToSpawn(
          spawnArgs({ launchAgent: agent, settings: { agentWorkspaceTrustEnabled: false } })
        )
      ).toBeNull()
      expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    })

    it('does nothing for a restored or reattached pane', () => {
      expect(
        applyAgentWorkspaceTrustToSpawn(spawnArgs({ launchAgent: agent, isFreshLaunch: false }))
      ).toBeNull()
      expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    })

    it('routes an SSH launch to its connection', async () => {
      await applyAgentWorkspaceTrustToSpawn(
        spawnArgs({ launchAgent: agent, worktreeId: 'repo-1::/srv/wt', connectionId: 'ssh-1' })
      )
      expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
        preset,
        '/srv/wt',
        expect.objectContaining({ connectionId: 'ssh-1' })
      )
    })

    it('passes the WSL distro so the writer targets the guest or skips', async () => {
      await applyAgentWorkspaceTrustToSpawn(spawnArgs({ launchAgent: agent, wslDistro: 'Ubuntu' }))
      expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
        preset,
        '/repo/wt',
        expect.objectContaining({ wslDistro: 'Ubuntu' })
      )
    })
  })

  it('forwards the relay field the dispatcher returns for an SSH launch', async () => {
    applyAgentWorkspaceTrust.mockResolvedValueOnce({
      agentWorkspaceTrust: { workspacePath: '/srv/wt' }
    })
    const spawnOptions = {}
    await applyAgentWorkspaceTrustToSpawn(
      spawnArgs({ worktreeId: 'repo-1::/srv/wt', connectionId: 'ssh-1', spawnOptions })
    )
    expect(spawnOptions).toEqual({ agentWorkspaceTrust: { workspacePath: '/srv/wt' } })
  })

  it('trusts Codex in a floating terminal at the folder it starts in', async () => {
    await applyAgentWorkspaceTrustToSpawn(
      spawnArgs({ launchAgent: 'codex', worktreeId: 'global-floating-terminal', cwd: '/Users/me' })
    )
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/Users/me', expect.anything())
  })

  it('trusts Codex at a subfolder it starts in, which its lookup keys on', async () => {
    await applyAgentWorkspaceTrustToSpawn(
      spawnArgs({ launchAgent: 'codex', worktreeId: 'folder:fw-1', cwd: '/notes/sub' })
    )
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/notes/sub', expect.anything())
  })

  it.each(PRESET_AGENTS.filter((agent) => agent !== 'codex'))(
    'trusts the workspace root for %s, whose trust covers its subfolders or matches the root',
    async (agent) => {
      await applyAgentWorkspaceTrustToSpawn(
        spawnArgs({ launchAgent: agent, worktreeId: 'folder:fw-1', cwd: '/notes/sub' })
      )
      expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
        TUI_AGENT_CONFIG[agent].preflightTrust,
        '/notes',
        expect.anything()
      )
    }
  )

  it('treats an unset setting as on', async () => {
    await applyAgentWorkspaceTrustToSpawn(spawnArgs({ settings: undefined }))
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an agent with no trust preset', { launchAgent: 'gemini' }],
    ['a plain terminal with no declared agent', { launchAgent: undefined }],
    ['a floating terminal', { worktreeId: 'global-floating-terminal', cwd: '/Users/me' }],
    [
      'Codex with no start folder and no workspace',
      { launchAgent: 'codex', worktreeId: 'global-floating-terminal' }
    ],
    ['an unknown folder workspace', { worktreeId: 'folder:missing' }],
    ['a spawn with no workspace', { worktreeId: undefined }]
  ])('does nothing, and gives the builder nothing to await, for %s', (_label, overrides) => {
    expect(applyAgentWorkspaceTrustToSpawn(spawnArgs(overrides))).toBeNull()
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
  })
})
