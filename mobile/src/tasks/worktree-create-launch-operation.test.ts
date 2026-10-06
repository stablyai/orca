import { describe, expect, it } from 'vitest'
import { parseAgentSessionOperationTimestamp } from '../../../src/shared/agent-session-host-authority'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS } from './worktree-create-idempotency-policy'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'

type Attempt = { method: string; params: Record<string, unknown> }

const IDEMPOTENT_CREATE_SUPPORT = { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS }

// Lets a parked replay reach its state wait before the test resumes the transport.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A transport scripted per call, recording what each attempt put on the wire. Narrower than the
// one `worktree-create-retry.test.ts` drives: the launch route needs a receipt, a coded refusal
// and one ambiguous drop, and nothing here reads the replay deadline.
function scriptedLaunchClient(
  outcomes: Array<
    | { launched: string }
    | { created: string }
    | { errorCode: string; errorMessage?: string }
    | { throws: unknown; dropsConnection?: boolean }
  >,
  attempts: Attempt[]
): RpcClient & { reconnect: () => void } {
  let call = 0
  let state: ConnectionState = 'connected'
  const listeners = new Set<(next: ConnectionState) => void>()
  const setState = (next: ConnectionState): void => {
    state = next
    for (const listener of listeners) {
      listener(next)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The retry loop reads only these members of RpcClient; spelling out the rest would be a fake transport pretending to be a real one.
  return {
    reconnect: () => setState('connected'),
    getState: () => state,
    getLastInboundAt: () => null,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendRequest: async (method: string, params?: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The port is untyped by construction; the suite asserts on what was sent, not on its declared shape.
      attempts.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if ('throws' in outcome) {
        if (outcome.dropsConnection) {
          setState('reconnecting')
        }
        throw outcome.throws
      }
      if ('errorCode' in outcome) {
        return {
          id: '1',
          ok: false,
          error: { code: outcome.errorCode, message: outcome.errorMessage ?? outcome.errorCode },
          _meta: { runtimeId: 'r' }
        }
      }
      return {
        id: '1',
        ok: true,
        // A launch answers with a bare `worktreeId`; `worktree.create` wraps one in `worktree`.
        result:
          'launched' in outcome
            ? {
                worktreeId: outcome.launched,
                outcome: { kind: 'terminal', handle: 'term_x' },
                receipt: {
                  mode: 'terminal',
                  preferred: 'terminal',
                  reason: 'user_default',
                  detail: 'Terminal selected'
                }
              }
            : { worktree: { id: outcome.created } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient & { reconnect: () => void }
}

// operationId names the full launch; the host owns suffix selection and bypasses the legacy cache.
describe('agent.launch operation id', () => {
  const launchOperationIds = (attempts: Attempt[]): unknown[] =>
    attempts.map((attempt) => attempt.params.operationId)
  const launchCandidateNames = (attempts: Attempt[]): unknown[] =>
    attempts.map((attempt) => {
      const target = attempt.params.target
      if (!target || typeof target !== 'object' || !('create' in target)) {
        return undefined
      }
      const create = target.create
      return create && typeof create === 'object' && 'name' in create ? create.name : undefined
    })

  function launchRetry(args: {
    client: RpcClient
    attempts: Attempt[]
    replay?: boolean
    supported?: boolean
    worktreeCreateIdempotency?: false
    mintLaunchOperationId?: () => string
  }): Promise<WorktreeCreateResult> {
    let minted = 0
    return createWorktreeWithNameRetry({
      client: args.client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: args.worktreeCreateIdempotency ?? IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => 'key-launch',
      agentLaunch: {
        agent: 'claude',
        supported: args.supported === false ? false : { replay: args.replay !== false }
      },
      mintLaunchOperationId: args.mintLaunchOperationId ?? (() => `op-${(minted += 1)}`)
    })
  }

  it('names the launch and reuses that name on an ambiguous replay of the same candidate', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [
        {
          throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
          dropsConnection: true
        },
        { launched: 'wt-launch' }
      ],
      attempts
    )
    const pending = launchRetry({ client, attempts })
    await flush()
    client.reconnect()

    await expect(pending).resolves.toEqual({ worktreeId: 'wt-launch', name: 'otter' })
    expect(attempts.map((attempt) => attempt.method)).toEqual([
      'agent.launchReplay',
      'agent.launchReplay'
    ])
    // The whole point: the replay is the SAME operation, so the host returns the recorded
    // answer instead of launching a second agent in a second workspace.
    expect(launchOperationIds(attempts)).toEqual(['op-1', 'op-1'])
  })

  it('reuses the launch name across a connection-migration cutover too', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [{ throws: new LogicalClientCutoverError() }, { launched: 'wt-mig' }],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      worktreeId: 'wt-mig',
      name: 'otter'
    })
    expect(launchOperationIds(attempts)).toEqual(['op-1', 'op-1'])
  })

  it('uses launch replay support independently of worktree.create idempotency', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [{ throws: new LogicalClientCutoverError() }, { launched: 'wt-replay' }],
      attempts
    )

    await expect(
      launchRetry({ client, attempts, worktreeCreateIdempotency: false })
    ).resolves.toEqual({ worktreeId: 'wt-replay', name: 'otter' })
    expect(launchOperationIds(attempts)).toEqual(['op-1', 'op-1'])
  })

  it('bounds named timeout retries without minting another operation', async () => {
    const attempts: Attempt[] = []
    const error = markRpcDeliveryUnknown(new Error('Request timed out'))
    const client = scriptedLaunchClient([{ throws: error }], attempts)

    await expect(launchRetry({ client, attempts })).rejects.toBe(error)
    expect(attempts).toHaveLength(3)
    expect(launchOperationIds(attempts)).toEqual(['op-1', 'op-1', 'op-1'])
  })

  it('does not restart the host name search with another operation after a collision', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [
        { errorCode: 'worktree_create_collision', errorMessage: 'already exists locally' },
        { launched: 'wt-bumped' }
      ],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      error: 'already exists locally'
    })
    expect(launchCandidateNames(attempts)).toEqual(['otter'])
    expect(launchOperationIds(attempts)).toEqual(['op-1'])
  })

  it('sends no launch name to a host that advertises agent.launch without the ledger', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient([{ launched: 'wt-plain' }], attempts)
    await expect(launchRetry({ client, attempts, replay: false })).resolves.toEqual({
      worktreeId: 'wt-plain',
      name: 'otter'
    })
    expect(attempts[0]!.method).toBe('agent.launch')
    expect(attempts[0]!.params.operationId).toBeUndefined()
    // Byte-identical to today: the rest of the payload is untouched.
    expect(attempts[0]!.params.target).toEqual({
      kind: 'create-worktree',
      create: { repo: 'id:r', name: 'otter', clientMutationId: 'key-launch' }
    })
  })

  it('sends no launch name at all when the host has no agent.launch', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient([{ created: 'wt-legacy-route' }], attempts)
    await expect(launchRetry({ client, attempts, supported: false })).resolves.toEqual({
      worktreeId: 'wt-legacy-route',
      name: 'otter'
    })
    expect(attempts[0]!.method).toBe('worktree.create')
    expect(attempts[0]!.params.operationId).toBeUndefined()
  })

  // These codes also describe a refused nested attach or an expired receipt after creation.
  it.each([
    'agent_session_operation_capacity',
    'agent_session_operation_invalid',
    'agent_session_operation_expired'
  ])('preserves the operation identity when the host refuses with %s', async (code) => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient([{ errorCode: code }, { launched: 'wt-unnamed' }], attempts)
    await expect(launchRetry({ client, attempts })).resolves.toEqual({ error: code })
    expect(attempts).toHaveLength(1)
    expect(launchOperationIds(attempts)).toEqual(['op-1'])
  })

  // An unsettled claim is evidence that the launch may already have run.
  it('surfaces an unknown operation without re-sending and without re-minting', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [{ errorCode: 'agent_session_operation_unknown' }],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      error: 'agent_session_operation_unknown'
    })
    expect(attempts).toHaveLength(1)
    expect(launchOperationIds(attempts)).toEqual(['op-1'])
  })

  // A conflict can only come from a client that reused one id across two payloads. Re-sending it
  // unnamed would hide that bug behind a create that quietly works.
  it('surfaces an operation conflict rather than re-sending unnamed', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [{ errorCode: 'agent_session_operation_conflict' }],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      error: 'agent_session_operation_conflict'
    })
    expect(attempts).toHaveLength(1)
  })

  // The pre-existing downgrade arm: a host that refuses the method drops to `worktree.create`,
  // which has no operation ledger, so the id must not ride along.
  it('drops the launch name when the host refuses agent.launch itself', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [
        { errorCode: 'method_not_found', errorMessage: 'Unknown method' },
        { created: 'wt-downgraded' }
      ],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      worktreeId: 'wt-downgraded',
      name: 'otter'
    })
    expect(attempts.map((attempt) => attempt.method)).toEqual([
      'agent.launchReplay',
      'worktree.create'
    ])
    expect(launchOperationIds(attempts)).toEqual(['op-1', undefined])
  })

  it('does not downgrade a launch when a replacement connection refuses the method', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient(
      [
        { throws: new LogicalClientCutoverError() },
        { errorCode: 'agent_launch_unsupported' },
        { created: 'wt-duplicate' }
      ],
      attempts
    )

    await expect(launchRetry({ client, attempts })).resolves.toEqual({
      error: 'agent_launch_unsupported'
    })
    expect(attempts.map((attempt) => attempt.method)).toEqual([
      'agent.launchReplay',
      'agent.launchReplay'
    ])
    expect(launchOperationIds(attempts)).toEqual(['op-1', 'op-1'])
  })

  it('mints a real durable id in production', async () => {
    const attempts: Attempt[] = []
    const client = scriptedLaunchClient([{ launched: 'wt-real' }], attempts)
    await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      agentLaunch: { agent: 'claude', supported: { replay: true } }
    })
    // The host refuses anything else on the wire; parsing it back is what proves the default
    // minter, not a test double, produces the shipped shape.
    expect(
      parseAgentSessionOperationTimestamp(String(attempts[0]!.params.operationId))
    ).toBeCloseTo(Date.now(), -4)
  })
})
