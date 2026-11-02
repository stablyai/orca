import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import {
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'

describe('worktree.create launch source', () => {
  const repo = {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git' as const
  }

  it('hands the surface that asked for a startup agent to the runtime', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches for a create with no provenance request.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
        run(),
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    // An open label: a surface this host has never heard of must not refuse the create.
    for (const launchSource of ['cli', 'a_surface_added_later']) {
      const response = await dispatcher.dispatch({
        id: 'req-1',
        authToken: 'tok',
        method: 'worktree.create',
        params: {
          repo: 'repo-1',
          name: 'agent-startup',
          startupAgent: 'codex',
          launchSource
        }
      })
      expect(response).toMatchObject({ ok: true })
      expect(runtime.createManagedWorktree).toHaveBeenLastCalledWith(
        expect.objectContaining({
          startupAgent: 'codex',
          startupLaunchSource: launchSource
        })
      )
    }
  })
})

/** Preserve independently updated CLI/phone worktree.create wire contracts while routing agent startup through the launch executor. */
describe('worktree.create with a startup agent', () => {
  const repo = {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git' as const
  }

  // `orca worktree create --name agent-task --agent claude --prompt "fix the login bug" --json`
  const CLI_AGENT_CREATE = {
    repo: 'id:repo-1',
    name: 'agent-task',
    displayName: 'agent-task',
    displayNameKind: 'user',
    runHooks: false,
    activate: false,
    noParent: false,
    cliProvenanceRequest: {},
    startupAgent: 'claude',
    startupPrompt: 'fix the login bug',
    launchSource: 'cli'
  }

  const PHONE_ISSUE_DRAFT_CREATE = {
    repo: 'id:repo-1',
    name: 'issue-88',
    displayName: 'Investigate login',
    displayNameKind: 'generated',
    setupDecision: 'skip',
    activate: true,
    startupDraft: 'https://github.com/acme/app/issues/88',
    createdWithAgent: 'codex',
    linkedIssue: 88,
    clientMutationId: 'mobile-mutation-1'
  }

  function harness(created: Record<string, unknown>) {
    const createManagedWorktree = vi.fn().mockResolvedValue(created)
    const resolveStartupDraftAgent = vi.fn(async (_repo: unknown, requested?: string) => requested)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches for a create with no automation provenance.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
        run(),
      showRepo: vi.fn().mockResolvedValue(repo),
      // The chat default is on: `worktree.create` still answers with a terminal agent.
      getClientSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }),
      getStructuredAgentSessionCreateSupport: vi.fn(async () => ({
        supported: true
      })),
      resolveStartupDraftAgent,
      createManagedWorktree
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const dispatch = (params: Record<string, unknown>) =>
      dispatcher.dispatch({
        id: 'req-1',
        authToken: 'tok',
        method: 'worktree.create',
        params
      })
    return { dispatch, createManagedWorktree, runtime }
  }

  it("answers the CLI's agent create with the same terminal handle, the prompt folded by the create", async () => {
    const { dispatch, createManagedWorktree, runtime } = harness({
      worktree: { id: 'repo-1::/wt/agent-task' },
      startupTerminal: {
        spawned: true,
        handle: 'term_agent',
        surface: 'background'
      }
    })

    const response = await dispatch(CLI_AGENT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: {
        worktree: { id: 'repo-1::/wt/agent-task' },
        startupTerminal: { handle: 'term_agent' },
        agentTerminalHandle: 'term_agent'
      }
    })
    expect(createManagedWorktree).toHaveBeenCalledTimes(1)
    const args = createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupAgent: 'claude',
      startupPrompt: 'fix the login bug',
      startupLaunchSource: 'cli',
      activate: false
    })
    expect(args).not.toHaveProperty('onStartupPromptCarry')
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it("leaves the phone's issue URL as an unsent draft and returns no agent handle, as before", async () => {
    const { dispatch, createManagedWorktree } = harness({
      worktree: { id: 'repo-1::/wt/issue-88' },
      startupTerminal: {
        spawned: true,
        handle: 'term_draft',
        surface: 'background'
      }
    })

    const response = await dispatch(PHONE_ISSUE_DRAFT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: { worktree: { id: 'repo-1::/wt/issue-88' } }
    })
    expect(response).not.toHaveProperty('result.agentTerminalHandle')
    const args = createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupDraft: 'https://github.com/acme/app/issues/88',
      createdWithAgent: 'codex',
      linkedIssue: 88,
      activate: true
    })
    expect(args).not.toHaveProperty('startupAgent')
    expect(args).not.toHaveProperty('startupPrompt')
  })

  it('answers without an agent handle when the create started no agent here', async () => {
    const { dispatch, createManagedWorktree } = harness({
      worktree: { id: 'repo-1::/wt/agent-task' },
      warning: 'Failed to create the startup terminal for /wt/agent-task: spawn failed'
    })

    const response = await dispatch(CLI_AGENT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: {
        warning: 'Failed to create the startup terminal for /wt/agent-task: spawn failed'
      }
    })
    expect(response).not.toHaveProperty('result.agentTerminalHandle')
    expect(createManagedWorktree).toHaveBeenCalledTimes(1)
  })
})

describe('worktree GitHub PR suppression RPC', () => {
  it('forwards suppression writes to host-owned metadata persistence', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.set',
      params: {
        worktree: 'id:wt-1',
        linkedPR: null,
        suppressedGitHubPR: 42
      }
    }

    const response = await new RpcDispatcher({
      runtime,
      methods: WORKTREE_METHODS
    }).dispatch(request)

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ linkedPR: null, suppressedGitHubPR: 42 })
    )
  })
})

describe('worktree missing-terminal teardown RPC', () => {
  it('routes the connection-scoped request through the runtime owner', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      teardownMissingManagedWorktreeTerminals: vi
        .fn()
        .mockResolvedValue({ stoppedWorktreeIds: ['repo-1::/workspace/deleted'] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'worktree.teardownMissingTerminals',
      params: {
        repo: 'repo-1',
        worktreeIds: ['repo-1::/workspace/deleted'],
        connectionId: 'ssh-1'
      }
    })

    expect(runtime.teardownMissingManagedWorktreeTerminals).toHaveBeenCalledWith(
      'repo-1',
      ['repo-1::/workspace/deleted'],
      'ssh-1'
    )
    expect(response).toMatchObject({ ok: true })
  })
})

describe('worktree.listRetiredNames', () => {
  // Keep the watermark beside names; older readers ignore it and under-retire compacted tiers.
  const RETIRED = {
    retiredNamesByRepo: { 'repo-1': ['nautilus-2'] },
    retiredNameTiersByRepo: { 'repo-1': 1 }
  }

  it('returns retired names and the compaction watermark, without the worktree listing', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRetiredWorktreeNames: vi.fn().mockResolvedValue(RETIRED)
    } as unknown as OrcaRuntimeService
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.listRetiredNames',
      params: { repo: 'id:repo-1' }
    }

    const response = await new RpcDispatcher({
      runtime,
      methods: WORKTREE_METHODS
    }).dispatch(request)

    expect(runtime.listRetiredWorktreeNames).toHaveBeenCalledWith('id:repo-1')
    expect(response).toMatchObject({ ok: true, result: RETIRED })
  })
})

describe('worktree.rm waits for the delete only for clients that can show it', () => {
  function makeRuntime(): OrcaRuntimeService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.rm with an explicit host reads only removeManagedWorktree.
    return {
      getRuntimeId: () => 'test-runtime',
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
  }

  async function dispatchRm(
    runtime: OrcaRuntimeService,
    clientCapabilities: readonly RuntimeCapability[] | undefined,
    params: Record<string, unknown> = {}
  ): Promise<RpcResponse> {
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    return dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'worktree.rm',
        params: { worktree: 'id:wt-1', hostId: 'local', ...params }
      },
      { clientCapabilities }
    )
  }

  // Only clients showing removing can wait out Git deletion; older clients need acceptance before timeout.

  it('asks the runtime to wait for a client that advertises background removal', async () => {
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY
    )
    const runtime = makeRuntime()
    await dispatchRm(runtime, ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ waitForBackgroundRemoval: true })
    )
  })

  it.each([
    ['a client that negotiated no capabilities', undefined],
    ['a client without background removal', []]
  ])('answers %s on acceptance', async (_name, capabilities) => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, capabilities)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      expect.not.objectContaining({ waitForBackgroundRemoval: true })
    )
  })

  it('waits for a caller that asks for the outcome, such as the CLI (#35135)', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.removeManagedWorktree).mockRejectedValue(
      new Error('working trees containing submodules cannot be moved or removed')
    )

    const response = await dispatchRm(runtime, undefined, { waitForBackgroundRemoval: true })

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ waitForBackgroundRemoval: true })
    )
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('containing submodules') }
    })
  })

  it('does not call an accepted, still-running delete removed', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.removeManagedWorktree).mockResolvedValue({ removing: true })

    const response = await dispatchRm(runtime, [])

    expect(response).toMatchObject({ ok: true, result: { removed: false, removing: true } })
  })
})

describe('worktree.rm host qualification', () => {
  function makeRuntime(repoHostIds: (string | undefined)[] = ['local']): OrcaRuntimeService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    return {
      getRuntimeId: () => 'test-runtime',
      listRepos: () =>
        repoHostIds.map((executionHostId) => ({
          id: 'repo-1',
          path: '/repo',
          executionHostId
        })),
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', hostId: 'local' }),
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
  }

  const WORKTREE_ID = 'repo-1::/repo/wt'

  function makeRequest(params: unknown): RpcRequest {
    return { id: 'req-1', authToken: 'tok', method: 'worktree.rm', params }
  }

  const forwarded = (hostId?: string): Record<string, unknown> => ({
    force: true,
    runHooks: false,
    allowUnverifiedPtyStop: false,
    allowFailedArchiveHook: false,
    waitForBackgroundRemoval: false,
    ...(hostId ? { hostId } : {})
  })

  it('routes an explicitly qualified removal to that host', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', hostId: 'local', force: true, runHooks: false })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', forwarded('local'))
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it("resolves a paired client's own name for this host to our spelling", async () => {
    const runtime = makeRuntime(['local'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      forwarded('local')
    )
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it('keeps a client-minted stamp this store still uses for its own repo', async () => {
    const runtime = makeRuntime(['runtime:env-1'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      forwarded('runtime:env-1')
    )
  })

  it('fails closed when the repo id carries both spellings', async () => {
    const runtime = makeRuntime(['local', 'runtime:env-1'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('ambiguous across hosts') }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('leaves an ssh qualifier alone, since we do proxy those onward', async () => {
    const runtime = makeRuntime(['ssh:target-a'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'ssh:target-a',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      forwarded('ssh:target-a')
    )
  })

  it.each([['bogus'], ['ssh:'], ['runtime:'], [''], [null], [42]])(
    'fails closed when an explicit host id is malformed: %j',
    async (hostId) => {
      const runtime = makeRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest({ worktree: 'id:wt-1', hostId, force: true, runHooks: false })
      )

      expect(response).toMatchObject({ ok: false })
      expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
      expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    }
  )

  it('resolves an old-client removal through the ambiguity-aware worktree lookup', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', forwarded('local'))
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it('fails closed when an old-client selector is ambiguous', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_ambiguous'))
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({ ok: false, error: { message: 'selector_ambiguous' } })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('fails closed when an old-client row has no host evidence', async () => {
    const runtime = makeRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the malformed row intentionally omits host evidence to exercise the rejection path.
    vi.mocked(runtime.showManagedWorktree).mockResolvedValue({ id: 'wt-1' } as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'worktree.rm could not resolve the workspace host' }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })
  // Git may already have dropped a stale row; unqualified deletion must still reach removeManagedWorktree.
  it('still deletes a stale workspace for an old client once Git no longer lists it', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_not_found'))
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-gone', force: true, runHooks: false })
    )

    expect(response).toMatchObject({ ok: true, result: { removed: true } })
    // Let removeManagedWorktree handle the stale row; it still refuses ids owned by two hosts.
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-gone', forwarded())
  })
})

describe('worktree.rm waivers travel on their own fields', () => {
  function makeRuntime(): OrcaRuntimeService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every runtime member reached by the requests in this suite.
    return {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
        run(),
      showManagedWorktree: vi.fn().mockResolvedValue({ hostId: 'ssh:builder' }),
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
  }

  /** Use wire params because dispatcher validation uses the Zod schema. */
  type RmParams = {
    hostId?: string
    force?: boolean
    runHooks?: boolean
    allowUnverifiedPtyStop?: boolean
    allowFailedArchiveHook?: boolean
  }

  async function dispatchRm(runtime: OrcaRuntimeService, params: RmParams): Promise<void> {
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', ...params }
    }
    await dispatcher.dispatch(request)
  }

  /** Default every waiver off; each case opts in explicitly. */
  const forwarded = (
    overrides: Partial<Record<string, unknown>> = {}
  ): Record<string, unknown> => ({
    force: false,
    runHooks: false,
    allowUnverifiedPtyStop: false,
    allowFailedArchiveHook: false,
    waitForBackgroundRemoval: false,
    hostId: 'local',
    ...overrides
  })

  // Waivers need independent fields (#11960, #19334): desktop force means confirmed deletion, not bypassing either gate.

  it.each([
    [
      'an explicit PTY-stop waiver reaches the runtime',
      { hostId: 'local', force: true, allowUnverifiedPtyStop: true, runHooks: false },
      forwarded({ force: true, allowUnverifiedPtyStop: true })
    ],
    [
      'force alone does NOT waive the PTY-stop proof',
      { hostId: 'local', force: true, runHooks: false },
      forwarded({ force: true })
    ],
    [
      'an explicit archive-hook waiver reaches the runtime',
      { hostId: 'local', runHooks: true, allowFailedArchiveHook: true },
      forwarded({ runHooks: true, allowFailedArchiveHook: true })
    ],
    [
      'force plus a PTY waiver does NOT waive a failed archive hook',
      { hostId: 'local', force: true, allowUnverifiedPtyStop: true, runHooks: true },
      forwarded({ force: true, runHooks: true, allowUnverifiedPtyStop: true })
    ]
  ])('%s', async (_name, params, expected) => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, params)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', expected)
  })

  it('resolves the host before forwarding an unqualified removal', async () => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, { force: true, runHooks: false })

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      forwarded({ force: true, hostId: 'ssh:builder' })
    )
  })
})
