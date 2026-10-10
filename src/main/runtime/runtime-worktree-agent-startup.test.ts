import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { getDefaultSettings } from '../../shared/constants'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

const mocks = vi.hoisted(() => ({
  detectRemoteAgents: vi.fn(),
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../preflight/agent-detection', () => ({
  detectRemoteAgents: mocks.detectRemoteAgents,
  detectInstalledAgentsWithShellPathHydration: mocks.detectInstalledAgentsWithShellPathHydration
}))

import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  resolveWorktreeCreateAgentStartup,
  resolveWorktreeStartupDraftAgent
} from './runtime-worktree-agent-startup'

function makeRepo(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    displayName: 'repo',
    badgeColor: '#737373',
    addedAt: 0,
    path: '/srv/repo',
    connectionId: null,
    executionHostId: null,
    ...fields
  }
}

const settings = {
  ...getDefaultSettings('/tmp'),
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: null
}

/** The launched CLI name is the whole decision: `orca` is the relay shim, `orca-ide` is local. */
function launchCliNameFor(repo: Repo): string {
  return buildWorktreeStartupForAgent({
    repo,
    settings,
    agent: 'claude-agent-teams',
    getLaunchPlatform: () => 'linux',
    toSessionOptions: () => undefined
  }).startup.command.split(' ')[0]!
}

describe('buildWorktreeStartupForAgent host resolution', () => {
  // Why two hosts: one SSH fixture passes even when the launch shape is resolved off another
  // host's row, which is the shape of the `ssh:m4air` -> openclaw leak.
  it('drops the Linux-only rename for both spellings of SSH ownership on two hosts', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air' }))).toBe('orca')
    expect(launchCliNameFor(makeRepo({ executionHostId: 'ssh:openclaw' }))).toBe('orca')
  })

  it('keeps the Linux rename for a local row carrying a stale connection', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air', executionHostId: 'local' }))).toBe(
      'orca-ide'
    )
  })

  it('drops the rename for a runtime host reaching a nested SSH target', () => {
    expect(
      launchCliNameFor(makeRepo({ connectionId: 'nested', executionHostId: 'runtime:vm-1' }))
    ).toBe('orca')
  })

  it('keeps the rename for a runtime host with no nested SSH target', () => {
    expect(launchCliNameFor(makeRepo({ executionHostId: 'runtime:vm-1' }))).toBe('orca-ide')
  })

  it('uses per-launch arguments and preserves launch telemetry', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'claude',
      agentArgs: '--model opus',
      launchSource: 'source_control_recovery',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })

    expect(result.startup.command).toContain("'--model'")
    expect(result.startup.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'source_control_recovery',
      request_kind: 'new'
    })
  })

  it('attributes a startup agent whose caller named no surface as unknown', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'claude',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })

    expect(result.startup.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'unknown',
      request_kind: 'new'
    })
  })
})

describe('buildWorktreeStartupForAgent prompt carry', () => {
  const build = (onPromptCarry?: (carried: boolean) => void, terminalDefaultShell = '/bin/bash') =>
    buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings: Object.assign({}, settings, { terminalDefaultShell }),
      agent: 'claude',
      prompt: 'summarize the diff\nthen list the risks',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined,
      ...(onPromptCarry ? { onPromptCarry } : {})
    })

  it('starts clean and reports it when a caller that pastes offers a prompt the line cannot carry', () => {
    const onPromptCarry = vi.fn()
    const result = build(onPromptCarry)

    expect(result.startup.command).not.toContain('summarize')
    expect(result.followup).toBeUndefined()
    expect(onPromptCarry).toHaveBeenCalledWith(false)
  })

  it('carries a short-lined multi-line prompt on a local zsh line, as main typed it', () => {
    const onPromptCarry = vi.fn()
    const result = build(onPromptCarry, '/bin/zsh')

    expect(result.startup.command).toContain('summarize the diff\nthen list the risks')
    expect(onPromptCarry).toHaveBeenCalledWith(true)
  })

  it('keeps folding the prompt for a caller that delivers nothing afterwards', () => {
    // `orca worktree create --prompt` has no post-start paste of its own for an argv agent.
    expect(build().startup.command).toContain('summarize the diff')
  })
})

// `worktree.create` through the launch executor passes no prompt for a blank one; the create must
// launch the agent exactly as it did when handed the blank text itself.
describe('buildWorktreeStartupForAgent blank prompt', () => {
  it.each(['claude', 'aider'] as const)(
    'launches %s bare for an absent or blank prompt',
    (agent) => {
      const build = (prompt?: string) =>
        buildWorktreeStartupForAgent({
          repo: makeRepo({}),
          settings,
          agent,
          ...(prompt !== undefined ? { prompt } : {}),
          getLaunchPlatform: () => 'linux',
          toSessionOptions: () => undefined
        })

      const bare = build()
      expect(bare.followup).toBeUndefined()
      expect(build('')).toEqual(bare)
      expect(build('  \n ')).toEqual(bare)
    }
  )
})

describe('buildWorktreeStartupForDraft agent detection', () => {
  it('probes the SSH host named only by executionHostId instead of this client', async () => {
    mocks.detectRemoteAgents.mockResolvedValueOnce(['claude'])
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue([])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ executionHostId: 'ssh:openclaw' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).toHaveBeenCalledWith({
      connectionId: 'openclaw'
    })
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })

  it('probes this client for a local row carrying a stale connection', async () => {
    mocks.detectRemoteAgents.mockClear()
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValueOnce(['claude'])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ connectionId: 'm4air', executionHostId: 'local' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })

  // The host picks and launches this agent itself, so it is attributed like any other it builds,
  // whether the draft rides the launch command or is pasted once the agent is up.
  it.each([
    ['claude', 'cli', 'cli', false],
    ['claude', undefined, 'unknown', false],
    ['claude-agent-teams', 'orchestration', 'orchestration', true],
    ['claude-agent-teams', undefined, 'unknown', true]
  ] as const)(
    'attributes a %s draft launch named %s as %s',
    async (agent, launchSource, expected, pasted) => {
      const result = await buildWorktreeStartupForDraft({
        repo: makeRepo({}),
        settings,
        draft: 'ship it',
        requestedAgent: agent,
        getLaunchPlatform: () => 'linux',
        ...(launchSource ? { launchSource } : {})
      })

      expect(result?.draftPaste !== undefined).toBe(pasted)
      expect(result?.startup.telemetry).toEqual({
        agent_kind: tuiAgentToAgentKind(agent),
        launch_source: expected,
        request_kind: 'new'
      })
    }
  )
})

describe('buildWorktreeStartupForAgent extra agent args', () => {
  it("merges an automation's extras over the host defaults", () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings: {
        ...settings,
        agentDefaultArgs: { claude: '--dangerously-skip-permissions --model sonnet' }
      },
      agent: 'claude',
      prompt: 'go',
      extraAgentArgs: '--model opus',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })

    expect(result.startup.command).toBe(
      "claude '--dangerously-skip-permissions' '--model' 'opus' 'go'"
    )
  })

  it('refuses invalid extras before any terminal exists', () => {
    expect(() =>
      buildWorktreeStartupForAgent({
        repo: makeRepo({}),
        settings,
        agent: 'claude',
        prompt: 'go',
        extraAgentArgs: '--settings evil.json',
        getLaunchPlatform: () => 'linux',
        toSessionOptions: () => undefined
      })
    ).toThrow('"--settings"')
  })

  it('threads worktree-create extras into the startup build', () => {
    const build = vi.fn(() => ({
      agent: 'claude' as const,
      startup: { command: 'claude' }
    }))
    const createArgs: RuntimeManagedWorktreeCreateArgs = {
      repoSelector: 'repo-1',
      name: 'Review',
      startupAgent: 'claude',
      startupPrompt: 'go',
      startupExtraAgentArgs: '--effort high'
    }
    resolveWorktreeCreateAgentStartup(createArgs, build)

    expect(build).toHaveBeenCalledWith('claude', 'go', undefined, {
      extraAgentArgs: '--effort high'
    })
  })
})

describe('resolveWorktreeStartupDraftAgent', () => {
  beforeEach(() => {
    mocks.detectRemoteAgents.mockReset()
    mocks.detectInstalledAgentsWithShellPathHydration.mockReset()
    mocks.detectRemoteAgents.mockResolvedValue([])
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue([])
  })
  afterEach(() => {
    mocks.detectRemoteAgents.mockReset()
    mocks.detectInstalledAgentsWithShellPathHydration.mockReset()
  })

  const resolve = (
    fields: Partial<Parameters<typeof resolveWorktreeStartupDraftAgent>[0]['settings']>,
    requestedAgent?: 'claude' | 'codex',
    repo = makeRepo({})
  ) =>
    resolveWorktreeStartupDraftAgent({
      repo,
      settings: { ...settings, ...fields },
      ...(requestedAgent ? { requestedAgent } : {})
    })

  it('returns an enabled requested agent without detecting', async () => {
    await expect(resolve({ defaultTuiAgent: 'claude' }, 'codex')).resolves.toBe('codex')
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
    expect(mocks.detectRemoteAgents).not.toHaveBeenCalled()
  })

  it('returns the default when nothing was requested', async () => {
    await expect(resolve({ defaultTuiAgent: 'claude' })).resolves.toBe('claude')
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
  })

  // The requested agent replaces the default rather than preceding it, so a disabled request goes
  // straight to detection — the order the create has always used.
  it('detects instead of using the default when the requested agent is disabled', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['codex', 'gemini'])

    await expect(
      resolve({ defaultTuiAgent: 'claude', disabledTuiAgents: ['codex'] }, 'codex')
    ).resolves.toBe('gemini')
    expect(mocks.detectInstalledAgentsWithShellPathHydration).toHaveBeenCalledTimes(1)
  })

  it('starts no agent when the default is blank', async () => {
    await expect(resolve({ defaultTuiAgent: 'blank' })).resolves.toBeNull()
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
  })

  it('detects an enabled agent on this host when nothing usable was named', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['codex', 'claude'])

    await expect(resolve({ disabledTuiAgents: ['codex'] })).resolves.toBe('claude')
    expect(mocks.detectRemoteAgents).not.toHaveBeenCalled()
  })

  it('detects on the SSH host that runs the agent', async () => {
    mocks.detectRemoteAgents.mockResolvedValue(['codex'])

    await expect(resolve({}, undefined, makeRepo({ connectionId: 'ssh-1' }))).resolves.toBe('codex')
    expect(mocks.detectRemoteAgents).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
  })

  it('starts no agent when detection finds none', async () => {
    await expect(resolve({})).resolves.toBeNull()
  })
})
