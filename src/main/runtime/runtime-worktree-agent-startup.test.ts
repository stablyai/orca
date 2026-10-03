import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'

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
  buildWorktreeStartupForDraft
} from './runtime-worktree-agent-startup'

function makeRepo(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    name: 'repo',
    path: '/srv/repo',
    connectionId: null,
    executionHostId: null,
    ...fields
  } as Repo
}

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: undefined,
  terminalWindowsShell: null
} as never

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

const incognitoSettings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: undefined,
  terminalWindowsShell: null,
  terminalIncognitoAgents: ['pi']
} as never

const staleClaudeIncognitoSettings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: undefined,
  terminalWindowsShell: null,
  // A stale/forged non-capable entry: the native flag must NOT be added for claude.
  terminalIncognitoAgents: ['claude', 'pi']
} as never

describe('new-workspace launch injects the native incognito flag (B1 regression, D1)', () => {
  it('adds --no-session on the agent path for a capable incognito agent', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings: incognitoSettings,
      agent: 'pi',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })
    expect(result.startup.command).toContain('--no-session')
  })

  it('does NOT add --no-session for a non-capable agent even if wrongly listed', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings: staleClaudeIncognitoSettings,
      agent: 'claude',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })
    expect(result.startup.command).not.toContain('--no-session')
  })

  it('does NOT add --no-session for a capable agent that is not in the incognito list', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'pi',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })
    expect(result.startup.command).not.toContain('--no-session')
  })

  it('adds --no-session on the DRAFT path for a capable incognito agent', async () => {
    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({}),
      settings: incognitoSettings,
      draft: 'ship it',
      requestedAgent: 'pi',
      getLaunchPlatform: () => 'linux'
    })
    expect(result?.startup.command).toContain('--no-session')
  })

  it('does NOT add --no-session on the DRAFT path for a non-capable agent', async () => {
    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({}),
      settings: staleClaudeIncognitoSettings,
      draft: 'ship it',
      requestedAgent: 'claude',
      getLaunchPlatform: () => 'linux'
    })
    expect(result?.startup.command).not.toContain('--no-session')
  })
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

    expect(mocks.detectRemoteAgents).toHaveBeenCalledWith({ connectionId: 'openclaw' })
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
