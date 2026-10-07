import { beforeEach, describe, expect, it, vi } from 'vitest'

const applyAgentWorkspaceTrust = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))
const adoption = vi.hoisted(() => ({
  committedReplay: vi.fn<() => unknown>(() => null),
  forCreate: vi.fn<() => Promise<unknown>>(async () => null)
}))
vi.mock('./structured-agent-session-create-adoption', () => ({
  resolveCommittedStructuredAgentSessionAdoptionIntent: adoption.committedReplay,
  resolveStructuredAgentSessionAdoptionForCreate: adoption.forCreate
}))

import { OrcaRuntimeService } from './orca-runtime'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'

beforeEach(() => {
  applyAgentWorkspaceTrust.mockClear()
  adoption.committedReplay.mockReset().mockReturnValue(null)
  adoption.forCreate.mockReset().mockResolvedValue(null)
})

function createCodexIntentRuntime(
  settings: Record<string, unknown>,
  workspaceId = 'workspace-1',
  workspacePath = '/repos/workspace-1'
) {
  const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
  const resolveRuntimeFileTarget = vi.fn(async () => ({ worktree: { path: workspacePath } }))
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
    { getSettings: () => ({ agentDefaultEnv: { codex: {} }, ...settings }) } as never,
    undefined,
    { prepareCodexStructuredLaunch }
  )
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
    supported: true
  })
  Object.assign(runtime, {
    resolveStructuredAgentSessionLocation: vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'git-worktree' as const
    })),
    resolveRuntimeFileTarget
  })
  const createIntent = (resumeFrom?: { providerSessionId: string }) =>
    runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: `id:${workspaceId}`,
      agent: 'codex',
      ...(resumeFrom ? { resumeFrom, callerKey: 'caller-1' } : {})
    })
  return { prepareCodexStructuredLaunch, resolveRuntimeFileTarget, createIntent }
}

describe('structured Codex folder trust', () => {
  it('takes a floating chat directory from the host-resolved workspace', async () => {
    const { createIntent } = createCodexIntentRuntime(
      {},
      FLOATING_TERMINAL_WORKTREE_ID,
      '/host/floating-folder'
    )

    const intent = await createIntent()

    expect(intent.hostLaunchDirectory).toBe('/host/floating-folder')
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
      'codex',
      '/host/floating-folder',
      expect.objectContaining({ codexHome: '/accounts/selected/home' })
    )
    expect(attachFingerprintFields(intent)).not.toHaveProperty('hostLaunchDirectory')
  })

  it('trusts the floating host launch directory, and a worktree chat its resolved path', async () => {
    const floating = createCodexIntentRuntime({}, FLOATING_TERMINAL_WORKTREE_ID, '/repos/later')
    // Why distinct: a hook that re-resolved the selector instead of using the host directory would pass otherwise.
    floating.resolveRuntimeFileTarget.mockResolvedValueOnce({
      worktree: { path: '/host/floating-folder' }
    })

    expect((await floating.createIntent()).hostLaunchDirectory).toBe('/host/floating-folder')
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(1)
    expect(applyAgentWorkspaceTrust).toHaveBeenLastCalledWith(
      'codex',
      '/host/floating-folder',
      expect.objectContaining({ codexHome: '/accounts/selected/home' })
    )

    const worktree = createCodexIntentRuntime({}, 'workspace-2', '/repos/workspace-2')
    expect((await worktree.createIntent()).hostLaunchDirectory).toBeUndefined()
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(2)
    expect(applyAgentWorkspaceTrust).toHaveBeenLastCalledWith(
      'codex',
      '/repos/workspace-2',
      expect.objectContaining({ codexHome: '/accounts/selected/home' })
    )
  })

  it('pre-trusts the chat folder in the account home launch preparation picks', async () => {
    const { prepareCodexStructuredLaunch, createIntent } = createCodexIntentRuntime({})

    await createIntent()

    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/repos/workspace-1', {
      env: undefined,
      claudeAuth: null,
      wslDistro: null,
      connectionId: null,
      codexHome: '/accounts/selected/home'
    })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(1)
    expect(prepareCodexStructuredLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      applyAgentWorkspaceTrust.mock.invocationCallOrder[0]
    )
  })

  it('pre-trusts a resumed chat in the home its conversation lives in', async () => {
    adoption.forCreate.mockResolvedValue({
      accountHomePath: '/accounts/original/home',
      transcriptPath: null
    })
    const { createIntent } = createCodexIntentRuntime({})

    const intent = await createIntent({ providerSessionId: 'thread-1' })

    expect(intent.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/accounts/original/home' })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(1)
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
      'codex',
      '/repos/workspace-1',
      expect.objectContaining({ codexHome: '/accounts/original/home' })
    )
  })

  it('writes nothing for a replay of a create that already committed', async () => {
    const replay = { replayed: true }
    adoption.committedReplay.mockReturnValue(replay)
    const { createIntent } = createCodexIntentRuntime({})

    await expect(createIntent({ providerSessionId: 'thread-1' })).resolves.toBe(replay)
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
  })

  it('writes nothing with the setting off, and still prepares the launch', async () => {
    const { prepareCodexStructuredLaunch, createIntent } = createCodexIntentRuntime({
      agentWorkspaceTrustEnabled: false
    })

    await createIntent()

    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(prepareCodexStructuredLaunch).toHaveBeenCalledTimes(1)
  })
})

describe('the Codex runtime registration', () => {
  const services = {
    getClaudeConfigDirectory: vi.fn(() => null),
    prepareCodexLaunchHome: vi.fn(() => '/accounts/selected/home'),
    readCodexLaunchHome: vi.fn(() => '/accounts/selected/home'),
    workspaceTrustSettings: () => ({ agentWorkspaceTrustEnabled: true })
  }

  it.each(['launch', 'read'] as const)(
    'resolves a %s account home without writing trust, which waits for the pinned home',
    async (purpose) => {
      const codex = structuredAgentRuntimeRegistration('codex')!
      await expect(
        codex.resolveAccountHomePath({ launchEnv: {}, location: null, purpose }, services)
      ).resolves.toBe('/accounts/selected/home')
      expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    }
  )

  it('writes trust into the home its post-pin step is given', async () => {
    const codex = structuredAgentRuntimeRegistration('codex')!
    await codex.afterAccountHomePinned!(
      { accountHomePath: '/accounts/pinned/home', workspacePath: async () => '/repos/workspace-1' },
      services
    )
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledTimes(1)
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
      'codex',
      '/repos/workspace-1',
      expect.objectContaining({ codexHome: '/accounts/pinned/home' })
    )
  })

  it('gives no other agent a post-pin step', () => {
    const withStep = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(
      (registration) => registration.afterAccountHomePinned
    ).map((registration) => registration.definition.agent)
    expect(withStep).toEqual(['codex'])
  })
})

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', fastMode: 'true' })
  })

  it('resolves the record-less catalog account home read-only, never through launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const resolveCodexStructuredLaunchHome = vi.fn(() => '/accounts/selected/home')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the account-home read only consumes getSettings from the store.
    const store = {
      getSettings: () => ({
        agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } }
      })
    } as never
    const runtime = new OrcaRuntimeService(store, undefined, {
      prepareCodexStructuredLaunch,
      resolveCodexStructuredLaunchHome
    })

    const accountHome = await runtime.resolveStructuredAgentAccountHome('codex')

    // A read must not run launch preparation: no home sync, no session bridge,
    // no cleared account selection — the read-only sibling answers instead.
    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    // A read pins no launch, so it writes no folder trust either.
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(resolveCodexStructuredLaunchHome).toHaveBeenCalledWith({
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(accountHome).toEqual({ variable: 'CODEX_HOME', path: '/accounts/selected/home' })
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    // Claude was never pre-trusted for a structured chat.
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({ model: 'opus', effort: 'high', fastMode: 'true' })
    // createSupport reports this same seed, so a paired client's picker shows what create runs.
    expect(runtime.structuredAgentSessionLaunchSeedOptions('claude')).toEqual(intent.options)
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir } as never,
      codexAccounts: {} as never,
      rateLimits: {} as never
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })
})
