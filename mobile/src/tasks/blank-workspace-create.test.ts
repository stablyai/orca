import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createBlankWorkspace } from './blank-workspace-create'
import { WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS } from './worktree-create-idempotency-policy'

type Call = { method: string; params: unknown }

const IDEMPOTENT_CREATE_SUPPORT = {
  dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS
}

function fakeClient(script: (method: string, call: number) => unknown, calls: Call[]): RpcClient {
  return {
    sendRequest: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const result = script(method, calls.length)
      if (result instanceof Error) {
        return {
          id: '1',
          ok: false,
          // `name` stands in for the wire error code, which is what tells a refused method apart
          // from a refused create.
          error: { code: result.name === 'Error' ? 'x' : result.name, message: result.message },
          _meta: { runtimeId: 'r' }
        }
      }
      return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
    }
  } as unknown as RpcClient
}

describe('createBlankWorkspace', () => {
  it('pins a manually entered blank-workspace name and sends no agent-launch fields', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-1' } }), calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    expect(result).toEqual({ worktreeId: 'wt-1', name: 'octopus' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: 'worktree.create',
      params: {
        repo: 'id:repo-1',
        setupDecision: 'inherit',
        name: 'octopus',
        displayName: 'octopus',
        displayNameKind: 'user',
        // Idempotency key so a create interrupted by a connection migration can be
        // safely retried without the host spawning a duplicate worktree.
        clientMutationId: expect.any(String)
      }
    })
    const params = calls[0]?.params as Record<string, unknown>
    expect('startupAgent' in params).toBe(false)
    expect('createdWithAgent' in params).toBe(false)
    expect('comment' in params).toBe(false)
  })

  it('marks the name as generated only when the user typed nothing', async () => {
    // Why: the host retires generated names permanently; a name the user chose must stay reusable.
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-3' } }), calls)

    await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: true,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    expect(calls[0]?.params).toMatchObject({ nameWasGenerated: true })
  })

  it('sends startupAgent (not a pre-built command) so the host resolves launch args', async () => {
    // Why: regression — the modal used to send a bare startupCommand ('claude')
    // that skipped the host's default `--dangerously-skip-permissions`.
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-2' } }), calls)

    await createBlankWorkspace({
      client,
      repoId: 'repo-2',
      baseName: 'manatee',
      createdWithAgentId: 'claude',
      comment: 'spike',
      setupDecision: 'run',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    const params = calls[0]?.params as Record<string, unknown>
    expect(params).toMatchObject({
      repo: 'id:repo-2',
      name: 'manatee',
      startupAgent: 'claude',
      setupDecision: 'run',
      createdWithAgent: 'claude',
      comment: 'spike'
    })
    expect('startupCommand' in params).toBe(false)
  })

  it('routes a picked agent through agent.launch on a host that advertises it', async () => {
    // The bug: `worktree.create` + `startupAgent` creates the worktree agent-first, so its startup
    // terminal IS the agent and the user's structured-chat default can never apply.
    const calls: Call[] = []
    const client = fakeClient(
      () => ({ worktreeId: 'wt-9', outcome: { kind: 'structured' } }),
      calls
    )

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-2',
      baseName: 'manatee',
      createdWithAgentId: 'claude',
      comment: 'spike',
      setupDecision: 'run',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunchSupported: true
    })

    expect(result).toEqual({ worktreeId: 'wt-9', name: 'manatee' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('agent.launch')
    const params = calls[0]?.params as {
      agent: string
      target: { kind: string; create: Record<string, unknown> }
    }
    expect(params.agent).toBe('claude')
    expect(params.target.kind).toBe('create-worktree')
    // Everything the create needs survives the move; only the agent fields the launch owns go.
    expect(params.target.create).toMatchObject({
      repo: 'id:repo-2',
      name: 'manatee',
      setupDecision: 'run',
      displayName: 'manatee',
      displayNameKind: 'user',
      comment: 'spike',
      clientMutationId: expect.any(String)
    })
    expect('startupAgent' in params.target.create).toBe(false)
  })

  it('keeps the agent-first create on a host that does not advertise agent.launch', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-10' } }), calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-2',
      baseName: 'manatee',
      createdWithAgentId: 'claude',
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunchSupported: false
    })

    expect(result).toEqual({ worktreeId: 'wt-10', name: 'manatee' })
    expect(calls[0]?.method).toBe('worktree.create')
    expect(calls[0]?.params).toMatchObject({ startupAgent: 'claude', createdWithAgent: 'claude' })
  })

  it('never launches for a blank choice, however capable the host is', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-11' } }), calls)

    await createBlankWorkspace({
      client,
      repoId: 'repo-2',
      baseName: 'manatee',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunchSupported: true
    })

    expect(calls[0]?.method).toBe('worktree.create')
    expect('startupAgent' in (calls[0]!.params as Record<string, unknown>)).toBe(false)
  })

  it('keeps the name-collision retry when the create goes through agent.launch', async () => {
    const calls: Call[] = []
    const client = fakeClient((_method, call) => {
      if (call === 1) {
        return new Error('Branch "octopus" already exists locally. Pick a different branch name.')
      }
      return { worktreeId: 'wt-12', outcome: { kind: 'terminal', handle: 't-1' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: 'codex',
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunchSupported: true
    })

    expect(result).toEqual({ worktreeId: 'wt-12', name: 'octopus-2' })
    expect(calls.map((call) => call.method)).toEqual(['agent.launch', 'agent.launch'])
    const retry = calls[1]?.params as { target: { create: { name: string } } }
    expect(retry.target.create.name).toBe('octopus-2')
  })

  it('downgrades to worktree.create when the host refuses the method itself', async () => {
    // The status.get probe can win the race against this client's own capability advertisement;
    // a refused method must not fail the create outright.
    const calls: Call[] = []
    const client = fakeClient((method) => {
      if (method === 'agent.launch') {
        const refusal = new Error("Method 'agent.launch' is not available to mobile clients")
        refusal.name = 'forbidden'
        return refusal
      }
      return { worktree: { id: 'wt-13' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: 'codex',
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunchSupported: true
    })

    expect(result).toEqual({ worktreeId: 'wt-13', name: 'octopus' })
    expect(calls.map((call) => call.method)).toEqual(['agent.launch', 'worktree.create'])
    expect(calls[1]?.params).toMatchObject({ startupAgent: 'codex' })
  })

  it('retries with a numeric suffix on a branch-collision error', async () => {
    const calls: Call[] = []
    const client = fakeClient((_method, call) => {
      if (call === 1) {
        return new Error('Branch "octopus" already exists locally. Pick a different branch name.')
      }
      return { worktree: { id: 'wt-3' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    expect(result).toEqual({ worktreeId: 'wt-3', name: 'octopus-2' })
    expect(calls).toHaveLength(2)
    const retryParams = calls[1]?.params as Record<string, unknown>
    expect(retryParams.name).toBe('octopus-2')
  })

  it('retries on the bare older-runtime collision message', async () => {
    const calls: Call[] = []
    const client = fakeClient((_method, call) => {
      if (call === 1) {
        return new Error('Branch "octopus" already exists.')
      }
      return { worktree: { id: 'wt-4' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    expect(result).toEqual({ worktreeId: 'wt-4', name: 'octopus-2' })
    expect(calls).toHaveLength(2)
  })

  it('surfaces a non-collision error without retrying', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => new Error('SSH connection is not available'), calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'skip',
      nameWasGenerated: false,
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      // Default the existing cases to an old host so they keep pinning the legacy create.
      agentLaunchSupported: false
    })

    expect(result).toEqual({ error: 'SSH connection is not available' })
    expect(calls).toHaveLength(1)
  })
})
