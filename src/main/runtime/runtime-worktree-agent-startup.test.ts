import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { getDefaultSettings } from '../../shared/constants'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'

const mocks = vi.hoisted(() => ({
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../preflight/agent-detection', () => ({
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

const LINUX_FACT: AgentLaunchRuntime = {
  platform: 'linux',
  pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
}
const LINUX = { platform: 'linux' as const, shell: 'posix' as const, launchRuntime: LINUX_FACT }

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
    getLaunchRuntime: () => LINUX,
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
      getLaunchRuntime: () => LINUX,
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
      getLaunchRuntime: () => LINUX,
      toSessionOptions: () => undefined
    })

    expect(result.startup.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'unknown',
      request_kind: 'new'
    })
  })
})

// Relied on by C2/C4: a host-built startup is typed into the shell it was quoted for.
it('quotes a worktree startup for its fact, not the Settings shell, and hands the fact on', () => {
  const pty = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
  const launchRuntime: AgentLaunchRuntime = { platform: 'win32', pty }
  const result = buildWorktreeStartupForAgent({
    repo: makeRepo({ path: 'C:\\repo' }),
    settings: { ...settings, terminalWindowsShell: 'wsl.exe' },
    agent: 'claude',
    prompt: "fix Bob's bug",
    getLaunchRuntime: () => ({ platform: 'win32', shell: 'powershell', launchRuntime }),
    toSessionOptions: () => undefined
  })
  expect(result.startup.command).toContain("'fix Bob''s bug'")
  expect(result.launchRuntime).toBe(launchRuntime)
})

describe('buildWorktreeStartupForAgent prompt carry', () => {
  const build = (onPromptCarry?: (carried: boolean) => void, terminalDefaultShell = '/bin/bash') =>
    buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings: Object.assign({}, settings, { terminalDefaultShell }),
      agent: 'claude',
      prompt: 'summarize the diff\nthen list the risks',
      getLaunchRuntime: () => ({
        ...LINUX,
        launchRuntime: {
          ...LINUX_FACT,
          pty: { shellOverride: terminalDefaultShell, terminalWindowsWslDistro: null }
        }
      }),
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
          getLaunchRuntime: () => LINUX,
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
  it('never probes this client for an SSH host named only by executionHostId', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['claude'])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ executionHostId: 'ssh:openclaw' }),
      settings,
      draft: 'ship it',
      getLaunchRuntime: () => LINUX
    })

    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('probes this client for a local row carrying a stale connection', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValueOnce(['claude'])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ connectionId: 'm4air', executionHostId: 'local' }),
      settings,
      draft: 'ship it',
      getLaunchRuntime: () => LINUX
    })

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
        getLaunchRuntime: () => LINUX,
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
      getLaunchRuntime: () => LINUX,
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
        getLaunchRuntime: () => LINUX,
        toSessionOptions: () => undefined
      })
    ).toThrow('"--settings"')
  })

  it('threads worktree-create extras into the startup build', () => {
    const build = vi.fn(() => ({
      agent: 'claude' as const,
      startup: { command: 'claude' },
      launchRuntime: LINUX_FACT
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

  it("merges a launch's account env over the startup plan's env", () => {
    const build = vi.fn(() => ({
      agent: 'codex' as const,
      startup: { command: 'codex', env: { CODEX_HOME: '/stale', KEEP: '1' } },
      launchRuntime: LINUX_FACT
    }))
    const resolved = resolveWorktreeCreateAgentStartup(
      {
        repoSelector: 'repo-1',
        name: 'Review',
        startupAgent: 'codex',
        startupAccountEnv: { CODEX_HOME: '/home/u/.codex-b' }
      },
      build
    )

    expect(resolved?.startup.env).toEqual({ CODEX_HOME: '/home/u/.codex-b', KEEP: '1' })
    expect(resolved?.launchRuntime).toBe(LINUX_FACT)
  })
})

describe('resolveWorktreeStartupDraftAgent', () => {
  beforeEach(() => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockReset()
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue([])
  })
  afterEach(() => {
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
  })

  // Why: the SSH host runs the agent; an unserved host must never be answered by this client.
  it('starts no agent on an unserved SSH host rather than detecting locally', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['codex'])

    await expect(resolve({}, undefined, makeRepo({ connectionId: 'ssh-1' }))).resolves.toBeNull()
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
  })

  it('starts no agent when detection finds none', async () => {
    await expect(resolve({})).resolves.toBeNull()
  })
})
