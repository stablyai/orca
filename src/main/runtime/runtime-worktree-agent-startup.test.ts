import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { MAX_LINE_PROMPT_BYTES } from '../../shared/launch-prompt-file'

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

describe('buildWorktreeStartupForAgent prompt carry', () => {
  const build = (prompt: string, platform: NodeJS.Platform = 'linux') =>
    buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'claude',
      prompt,
      getLaunchPlatform: () => platform,
      toSessionOptions: () => undefined
    })

  it('carries a multi-line prompt on the startup command, which the host stages', () => {
    const result = build('summarize the diff\nthen list the risks')
    expect(result.startup.command).toContain('summarize the diff\nthen list the risks')
    expect(result.startup.launchFile).toBeUndefined()
    expect(result.followup).toBeUndefined()
  })

  it('hands a prompt past the argv ceiling to the host as a launch file', () => {
    const prompt = 'x'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    const result = build(prompt)
    expect(result.startup.launchFile?.content).toBe(prompt)
    expect(result.startup.command).toContain(result.startup.launchFile?.placeholder)
    expect(result.startup.command).not.toContain('xxxx')
  })

  // Why: measured on PowerShell, a short multi-line line arrives and a 9 KB one does not. PowerShell
  // quotes it onto one physical line (#23672).
  it('keeps a short multi-line prompt on a Windows line and points a long one at a file', () => {
    expect(build('summarize the diff\nthen list the risks', 'win32').startup.command).toContain(
      '"summarize the diff`nthen list the risks"'
    )
    const long = Array.from({ length: 20 }, (_, i) => `step ${i} `.padEnd(500, 'x')).join('\n')
    const result = build(long, 'win32')
    expect(result.startup.launchFile?.content).toBe(long)
    expect(result.startup.command).not.toContain('step 1 ')
  })

  it('leaves a prompt needing a file the agent is not known to read as the follow-up paste', () => {
    const prompt = 'x'.repeat(MAX_LINE_PROMPT_BYTES + 1)
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'gemini',
      prompt,
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })
    expect(result.startup.launchFile).toBeUndefined()
    expect(result.followup?.prompt).toBe(prompt)
  })

  it('reports that prompt uncarried, with no follow-up, to a caller that pastes it itself', () => {
    const onPromptCarry = vi.fn()
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'gemini',
      prompt: 'x'.repeat(MAX_LINE_PROMPT_BYTES + 1),
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined,
      onPromptCarry
    })
    expect(onPromptCarry).toHaveBeenCalledExactlyOnceWith(false)
    expect(result.followup).toBeUndefined()
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
