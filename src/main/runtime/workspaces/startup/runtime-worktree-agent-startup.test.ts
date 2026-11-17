import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import '../../../../shared/agent-status/identity/agent-kind'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'

import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'

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
  buildWorktreeStartupForDraft
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
