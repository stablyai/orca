import { describe, expect, it, vi } from 'vitest'
import {
  runWorktreeRetryAgentLaunch,
  type RetryRecoveryGate,
  type WorktreeRetryAgentLaunchDeps,
  type WorktreeRetryAgentLaunchParams,
  type WorktreeRetryAgentLaunchResult,
  type WorktreeRetryInFlight
} from './agent-launch-worktree-retry'
import { AgentLaunchOperationStore, canonicalPayloadDigest } from './agent-launch-operation-store'
import type { AgentLaunchSpawnRequest } from '../../shared/agent-launch-spawn-request'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'

const WORKTREE = 'repo::/wt'
const FAILURE_ID = 'f1'
const IDEMPOTENCY_KEY = 'key-abc'

function durableFailure(
  overrides: Partial<PersistedAgentLaunchFailure> = {}
): PersistedAgentLaunchFailure {
  return {
    code: 'spawn_failed',
    requestedAgent: 'claude',
    version: 1,
    failureId: FAILURE_ID,
    intent: 'interactive',
    occurredAt: 1,
    ...overrides
  }
}

type Harness = {
  deps: WorktreeRetryAgentLaunchDeps
  runLaunch: ReturnType<typeof vi.fn>
  registerInFlight: ReturnType<typeof vi.fn>
  resolveSettled: ReturnType<typeof vi.fn>
  store: AgentLaunchOperationStore
  requests: AgentLaunchSpawnRequest[]
}

function harness(overrides: Partial<WorktreeRetryAgentLaunchDeps> = {}): Harness {
  const store = new AgentLaunchOperationStore()
  const requests: AgentLaunchSpawnRequest[] = []
  const launched: WorktreeRetryAgentLaunchResult = {
    status: 'launched',
    receipt: {
      requestedAgent: 'claude',
      baseAgent: 'claude',
      notices: [],
      launchToken: 'tok',
      catalogRevision: 1,
      telemetry: { agentKind: 'claude-code', usedCustomAgent: false }
    }
  }
  const runLaunch = vi.fn(async (input: { request: AgentLaunchSpawnRequest }) => {
    requests.push(input.request)
    return launched
  })
  const registerInFlight = vi.fn()
  const resolveSettled = vi.fn(
    (): WorktreeRetryAgentLaunchResult => ({ status: 'launched', receipt: launched.receipt })
  )
  const deps: WorktreeRetryAgentLaunchDeps = {
    operationStore: store,
    idempotencyKeyFor: () => IDEMPOTENCY_KEY,
    findInFlight: () => null,
    registerInFlight,
    resolveSettled,
    loadDurableFailure: () => durableFailure(),
    resolveRecoveryGate: (): RetryRecoveryGate => ({ kind: 'retryable' }),
    runLaunch,
    ...overrides
  }
  return { deps, runLaunch, registerInFlight, resolveSettled, store, requests }
}

const RETRY_SAME: WorktreeRetryAgentLaunchParams = {
  scope: WORKTREE,
  expectedFailureId: FAILURE_ID,
  clientMutationId: '00000000-0000-4000-8000-000000000000',
  action: { kind: 'retry-same' }
}

describe('runWorktreeRetryAgentLaunch idempotency', () => {
  it('replays the settled ledger result when key + payload match', async () => {
    const h = harness()
    h.store.recordSettled({
      operationId: 'op1',
      idempotencyKey: IDEMPOTENCY_KEY,
      scope: WORKTREE,
      payloadDigest: canonicalPayloadDigest({ kind: 'retry-same' }),
      status: 'launched',
      terminalId: 't1',
      failureId: null,
      settledAt: 1
    })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result.status).toBe('launched')
    expect(h.resolveSettled).toHaveBeenCalledOnce()
    expect(h.runLaunch).not.toHaveBeenCalled()
  })

  it('returns idempotency_conflict when the settled key is reused with a different payload', async () => {
    const h = harness()
    h.store.recordSettled({
      operationId: 'op1',
      idempotencyKey: IDEMPOTENCY_KEY,
      scope: WORKTREE,
      payloadDigest: canonicalPayloadDigest({ kind: 'change-agent', agent: 'codex' }),
      status: 'launched',
      terminalId: 't1',
      failureId: null,
      settledAt: 1
    })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({ status: 'rejected', requestError: { code: 'idempotency_conflict' } })
    expect(h.runLaunch).not.toHaveBeenCalled()
  })

  it('joins the in-flight promise when key + payload match', async () => {
    const inflightResult: WorktreeRetryAgentLaunchResult = {
      status: 'launched',
      receipt: {
        requestedAgent: 'claude',
        baseAgent: 'claude',
        notices: [],
        launchToken: 'inflight',
        catalogRevision: 1,
        telemetry: { agentKind: 'claude-code', usedCustomAgent: false }
      }
    }
    const inFlight: WorktreeRetryInFlight = {
      payloadDigest: canonicalPayloadDigest({ kind: 'retry-same' }),
      promise: Promise.resolve(inflightResult)
    }
    const h = harness({ findInFlight: () => inFlight })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toBe(inflightResult)
    expect(h.runLaunch).not.toHaveBeenCalled()
  })

  it('returns idempotency_conflict when an in-flight key has a different payload', async () => {
    const inFlight: WorktreeRetryInFlight = {
      payloadDigest: canonicalPayloadDigest({ kind: 'change-agent', agent: 'codex' }),
      promise: Promise.resolve({ status: 'launched' } as WorktreeRetryAgentLaunchResult)
    }
    const h = harness({ findInFlight: () => inFlight })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({ status: 'rejected', requestError: { code: 'idempotency_conflict' } })
  })
})

describe('runWorktreeRetryAgentLaunch guards', () => {
  it('rejects with stale_agent_launch_failure when the durable failure is gone', async () => {
    const h = harness({ loadDurableFailure: () => null })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(h.runLaunch).not.toHaveBeenCalled()
  })

  it('rejects with stale_agent_launch_failure when expectedFailureId mismatches', async () => {
    const h = harness({ loadDurableFailure: () => durableFailure({ failureId: 'other' }) })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
  })

  it('blocks with launch_state_unknown without mutation when liveness is unknown', async () => {
    const h = harness({ resolveRecoveryGate: () => ({ kind: 'launch_state_unknown' }) })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({ status: 'blocked', failure: { code: 'launch_state_unknown' } })
    expect(h.runLaunch).not.toHaveBeenCalled()
  })

  it('blocks with invalid_launch_snapshot while a token-live terminal lacks attribution', async () => {
    const h = harness({ resolveRecoveryGate: () => ({ kind: 'invalid_launch_snapshot' }) })
    const result = await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(result).toEqual({ status: 'blocked', failure: { code: 'invalid_launch_snapshot' } })
  })
})

describe('runWorktreeRetryAgentLaunch action resolution', () => {
  it('retry-same launches the pinned identity with persisted workspace authority', async () => {
    const h = harness()
    await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(h.requests[0]).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      allowEmptyPromptLaunch: true,
      sourceRecord: { owner: 'workspace' }
    })
    expect(h.runLaunch.mock.calls[0][0].priorFailureId).toBe(FAILURE_ID)
    expect(h.registerInFlight).toHaveBeenCalledOnce()
  })

  it('retry-same with no pinned identity launches the host default', async () => {
    const h = harness({ loadDurableFailure: () => durableFailure({ requestedAgent: undefined }) })
    await runWorktreeRetryAgentLaunch(h.deps, RETRY_SAME)
    expect(h.requests[0]).toEqual({
      selection: { kind: 'default' },
      allowEmptyPromptLaunch: true
    })
  })

  it('change-agent launches a live selection with no fallback authority', async () => {
    const h = harness()
    await runWorktreeRetryAgentLaunch(h.deps, {
      ...RETRY_SAME,
      action: { kind: 'change-agent', agent: 'codex' }
    })
    expect(h.requests[0]).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true
    })
    expect(h.requests[0]).not.toHaveProperty('sourceRecord')
  })
})
