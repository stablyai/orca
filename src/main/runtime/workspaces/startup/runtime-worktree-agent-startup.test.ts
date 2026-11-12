import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import '../../../../shared/agent-kind'
import { getDefaultSettings } from '../../../../shared/constants'

import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from '../../rpc/methods/workspaces/worktree-create-args'
import { resolveManagedWorktreeCreateStartup } from './managed-worktree-create-startup'
import { tokenizeStartupCommand } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'

const mocks = vi.hoisted(() => ({
  detectInstalledAgentsWithShellPathHydration: vi.fn(),
  capabilities: vi.fn(),
  executable: vi.fn(),
  modelContext: vi.fn()
}))

vi.mock('../../../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: mocks.detectInstalledAgentsWithShellPathHydration
}))

vi.mock('../../../opencode/model-launch/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: mocks.capabilities
}))
vi.mock('../../../opencode/model-launch/opencode-model-executable', () => ({
  resolveOpenCodeDirectModelExecutable: mocks.executable
}))
vi.mock('../../../opencode/model-launch/opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: mocks.modelContext
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

it.each([false, true])(
  'applies a prospective effort clear at current managed startup (draft %s)',
  async (draft) => {
    const args = buildManagedWorktreeCreateArgs(
      WorktreeCreate.parse({
        repo: 'repo-1',
        startupAgent: 'antigravity',
        startupTerminalOptionEdits: { effort: null },
        ...(draft ? { startupDraft: 'ship it' } : {})
      }),
      {}
    )
    const environment = {
      repo: makeRepo({}),
      settings: {
        ...settings,
        agentCmdOverrides: { antigravity: 'agy' },
        agentPermissionDefault: 'full-access' as const,
        agentDefaultArgs: { antigravity: '--effort=medium --add-dir current' },
        agentLaunchChoices: { antigravity: { options: { effort: 'low' } } }
      },
      getLaunchRuntime: () => LINUX
    }
    const result = await resolveManagedWorktreeCreateStartup(args, [], {
      agent: (agent, prompt, launchPreferences, inputs) =>
        buildWorktreeStartupForAgent({
          ...environment,
          ...inputs,
          agent,
          prompt,
          launchPreferences,
          toSessionOptions: () => undefined
        }),
      draft: (content, requestedAgent, launchSource, inputs) =>
        buildWorktreeStartupForDraft({
          ...environment,
          draft: content,
          requestedAgent,
          launchSource,
          terminalOptionEdits: inputs?.startupTerminalOptionEdits
        })
    })
    expect(tokenizeStartupCommand(result.effectiveStartup?.command ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: ['agy', '--dangerously-skip-permissions', '--add-dir', 'current']
    })
    if (draft) {
      expect(result.effectiveDraftPaste).toEqual({ agent: 'antigravity', content: 'ship it' })
    }
  }
)

/** The launched CLI name is the whole decision: `orca` is the relay shim, `orca-ide` is local. */
async function launchCliNameFor(repo: Repo): Promise<string> {
  return (
    await buildWorktreeStartupForAgent({
      repo,
      settings,
      agent: 'claude-agent-teams',
      getLaunchRuntime: () => LINUX,
      toSessionOptions: () => undefined
    })
  ).startup.command.split(' ')[0]!
}

describe('buildWorktreeStartupForAgent host resolution', () => {
  // Two hosts catch launch shapes resolved from another host's row (ssh:m4air to openclaw leak).
  it('drops the Linux-only rename for both spellings of SSH ownership on two hosts', async () => {
    expect(await launchCliNameFor(makeRepo({ connectionId: 'm4air' }))).toBe('orca')
    expect(await launchCliNameFor(makeRepo({ executionHostId: 'ssh:openclaw' }))).toBe('orca')
  })

  it('keeps the Linux rename for a local row carrying a stale connection', async () => {
    expect(
      await launchCliNameFor(makeRepo({ connectionId: 'm4air', executionHostId: 'local' }))
    ).toBe('orca-ide')
  })

  it('drops the rename for a runtime host reaching a nested SSH target', async () => {
    expect(
      await launchCliNameFor(makeRepo({ connectionId: 'nested', executionHostId: 'runtime:vm-1' }))
    ).toBe('orca')
  })

  it('uses the headless runtime CLI with no nested SSH target (#33920)', async () => {
    expect(await launchCliNameFor(makeRepo({ executionHostId: 'runtime:vm-1' }))).toBe('orca')
  })
})

// Host-built startup must use the same shell fact for quoting and spawn.
it('quotes a worktree startup for its fact, not the Settings shell, and hands the fact on', async () => {
  const pty = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
  const launchRuntime: AgentLaunchRuntime = { platform: 'win32', pty }
  const result = await buildWorktreeStartupForAgent({
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

  it('starts clean and reports it when a caller that pastes offers a prompt the line cannot carry', async () => {
    const onPromptCarry = vi.fn()
    const result = await build(onPromptCarry)

    expect(result.startup.command).not.toContain('summarize')
    expect(result.followup).toBeUndefined()
    expect(onPromptCarry).toHaveBeenCalledWith(false)
  })

  it('carries a short-lined multi-line prompt on a local zsh line, as main typed it', async () => {
    const onPromptCarry = vi.fn()
    const result = await build(onPromptCarry, '/bin/zsh')

    expect(result.startup.command).toContain('summarize the diff\nthen list the risks')
    expect(onPromptCarry).toHaveBeenCalledWith(true)
  })

  it('keeps folding the prompt for a caller that delivers nothing afterwards', async () => {
    // `orca worktree create --prompt` has no post-start paste of its own for an argv agent.
    expect((await build()).startup.command).toContain('summarize the diff')
  })
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
})

describe('buildWorktreeStartupForAgent extra agent args', () => {
  it('refuses invalid extras before any terminal exists', async () => {
    await expect(
      buildWorktreeStartupForAgent({
        repo: makeRepo({}),
        settings,
        agent: 'claude',
        prompt: 'go',
        extraAgentArgs: '--settings evil.json',
        getLaunchRuntime: () => LINUX,
        toSessionOptions: () => undefined
      })
    ).rejects.toThrow('"--settings"')
  })

  it("merges a launch's account env over the startup plan's env", async () => {
    const build = vi.fn(() => ({
      agent: 'codex' as const,
      startup: { command: 'codex', env: { CODEX_HOME: '/stale', KEEP: '1' } },
      launchRuntime: LINUX_FACT
    }))
    const resolved = await resolveWorktreeCreateAgentStartup(
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

  // An unserved SSH host cannot be answered by local detection.
  it('starts no agent on an unserved SSH host rather than detecting locally', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['codex'])

    await expect(resolve({}, undefined, makeRepo({ connectionId: 'ssh-1' }))).resolves.toBeNull()
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
  })
})

describe('paired workspace draft inputs', () => {
  it('keeps the disabled-agent draft substitution without applying the original picks or Arguments', async () => {
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['codex'])
    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({}),
      settings: {
        ...settings,
        disabledTuiAgents: ['claude'],
        agentDefaultArgs: { codex: '--model host-model' }
      },
      draft: 'ship it',
      requestedAgent: 'claude',
      agentArgs: '--add-dir /claude-only',
      sessionOptions: { model: 'opus' },
      getLaunchRuntime: () => LINUX
    })
    expect(result?.agent).toBe('codex')
    expect(result?.startup.command).toContain('host-model')
    expect(result?.startup.command).not.toContain('opus')
    expect(result?.startup.command).not.toContain('/claude-only')
    expect(result?.draftPaste).toEqual({ agent: 'codex', content: 'ship it' })
  })
})

it('compiles an OpenCode model inside host startup while retaining draft delivery and runtime', async () => {
  mocks.capabilities.mockResolvedValue({
    version: '2.0.16',
    pluginApi: 'v2',
    promptMode: 'prefill'
  })
  mocks.executable.mockResolvedValue('/host/opencode')
  mocks.modelContext.mockResolvedValue({ primaryAgent: 'build' })
  const launchRuntime: AgentLaunchRuntime = {
    platform: process.platform,
    pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
  }
  const environment = {
    repo: makeRepo({}),
    settings,
    getLaunchRuntime: () => ({
      platform: process.platform,
      shell: 'posix' as const,
      launchRuntime
    }),
    sessionOptions: { model: 'opencode/fledge-alpha-free' }
  }
  const built = await buildWorktreeStartupForAgent({
    ...environment,
    agent: 'opencode',
    prompt: 'go',
    toSessionOptions: () => undefined
  })
  expect(built.startup.command).toContain('--standalone')
  expect(built.startup.command).not.toContain('--model')
  expect(JSON.parse(built.startup.env?.OPENCODE_CONFIG_CONTENT ?? 'null')).toMatchObject({
    model: 'opencode/fledge-alpha-free'
  })
  expect(built.startup.launchConfig?.agentArgs).not.toContain('--standalone')
  expect(built.launchRuntime).toBe(launchRuntime)
  const draft = await buildWorktreeStartupForDraft({
    ...environment,
    draft: 'ship it',
    requestedAgent: 'opencode'
  })
  expect(draft?.startup.command).toContain('--standalone')
  expect(draft?.draftPaste).toEqual({ agent: 'opencode', content: 'ship it' })
  const substituted = await buildWorktreeStartupForDraft({
    ...environment,
    draft: 'ship it',
    requestedAgent: 'opencode',
    originalAgent: 'claude',
    sessionOptions: { model: 'opus' },
    agentArgs: '--add-dir /claude-only'
  })
  expect(substituted?.startup.command).not.toContain('opus')
  expect(substituted?.startup.command).not.toContain('/claude-only')
  expect(substituted?.draftPaste).toEqual({ agent: 'opencode', content: 'ship it' })
})

it('keeps the legacy OpenCode model recipe on SSH, including inherited choices and draft delivery', async () => {
  const environment = {
    repo: makeRepo({ connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }),
    settings: {
      ...settings,
      agentLaunchChoices: { opencode: { model: 'provider/model' } },
      agentDefaultArgs: { opencode: '--port 5000' }
    },
    getLaunchRuntime: () => ({
      platform: 'linux' as const,
      shell: 'posix' as const,
      launchRuntime: new Error('SSH runtime')
    })
  }
  const built = await buildWorktreeStartupForAgent({
    ...environment,
    agent: 'opencode',
    prompt: 'go',
    toSessionOptions: () => undefined,
    sessionOptions: { model: 'provider/picked' }
  })
  expect(built.startup.command).toBe(
    "opencode '--port' '5000' '--model' 'provider/picked' --prompt 'go'"
  )
  const inherited = await buildWorktreeStartupForDraft({
    ...environment,
    requestedAgent: 'opencode',
    draft: 'ship it'
  })
  expect(inherited?.startup.command).toBe("opencode '--port' '5000' '--model' 'provider/model'")
  expect(inherited?.draftPaste).toEqual({ agent: 'opencode', content: 'ship it' })
})
