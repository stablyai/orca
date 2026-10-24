import '../unused-default-rpc-methods.test-fixture'
/**
 * Replay safety for `agent.launch`, against the real durable ledger.
 *
 * The property under test is narrow and total: one execution per operation, a recorded answer for
 * every replay, a truthful refusal when the outcome is unknown. Each guard here has an ablation
 * beside it, because a replay test that never watched the unguarded code duplicate is a test of the
 * harness rather than of the guard.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import {
  computeAgentLaunchFingerprint,
  deriveAgentLaunchChildOperationId,
  type AgentLaunchFingerprintInput
} from '../../../../shared/agent-launch-operation'
import {
  agentSessionOperationKey,
  claimAgentSessionOperation,
  isAgentSessionOperationRow,
  settleAgentSessionOperation,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../agent-session-record-store-test-harness'
import { StoreRuntimeState } from '../../../persistence/loading-store/store-runtime-state'
import { createStoreDomains } from '../../../persistence/loading-store/store-domain-composition'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../../shared/worktree/meta-persisted-defaults'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  STRUCTURED_PREFERENCE,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

type StructuredCreateReply =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; refusal: { code: string; message: string } }

/** Records the operation id the launch handed its inner attach, so the child-id rule is observable
 *  rather than inferred. */
const attachOperationIds: string[] = []
const attachCallerKeys: string[] = []

const createStructuredSession = vi.fn(
  async (args: {
    caller: { callerKey: string }
    envelope: { clientOperationId: string }
  }): Promise<StructuredCreateReply> => {
    attachOperationIds.push(args.envelope.clientOperationId)
    attachCallerKeys.push(args.caller.callerKey)
    return { ok: true, value: { sessionId: 'sess-1' } }
  }
)

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: {
    caller: { callerKey: string }
    envelope: { clientOperationId: string }
  }) => createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')

const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

// Real wall-clock, because the handler admits against `Date.now()`: the ledger refuses an id dated
// far from now in either direction, so a frozen fixture timestamp would only ever test that.
const NOW = Date.now()
const OPERATION_ID = `${NOW}-000000000000000000000000000000aa`

const PAIRED_CLIENT: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientId: 'credential-a',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
const ROTATED_CREDENTIAL_CLIENT: Partial<RpcContext> = {
  ...PAIRED_CLIENT,
  clientId: 'credential-b',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

let directory: string
let store: AgentSessionRecordStore

function metadataOwner(state: ReturnType<typeof getDefaultPersistedState>) {
  const runtime = new StoreRuntimeState({ dataFile: join(directory, 'metadata.json') })
  runtime.state = state
  return createStoreDomains(runtime).metadata
}

function metadataRow(instanceId: string) {
  return {
    ...WORKTREE_META_PERSISTED_DEFAULTS,
    instanceId,
    displayName: '',
    comment: '',
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

type LaunchParams = AgentLaunchFingerprintInput & { operationId?: string }

function createLaunch(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    agent: 'claude',
    target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
    ...overrides
  }
}

async function launch(
  params: LaunchParams,
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext> = PAIRED_CLIENT
) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
}

function rowFor(operationId: string): AgentSessionOperationRow | undefined {
  return store.listOperationRows().find((row) => row.operationId === operationId)
}

beforeEach(async () => {
  attachOperationIds.length = 0
  attachCallerKeys.length = 0
  createStructuredSession.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-replay-'))
  store = await openTestAgentSessionRecordStore(directory)
  // The ledger alone, as admission opens it: no chat host is installed.
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

describe('exactly one execution per launch operation', () => {
  it('holds the requested workspace instance through same-operation joins and checks canonical and legacy occupants before creation', async () => {
    const instanceId = '94d38a16-e9db-4e86-b81d-334788958124'
    const state = getDefaultPersistedState('/fixture')
    const metadata = metadataOwner(state)
    const runtime = runtimeStub()
    runtime.requireStore.mockReturnValue(
      Object.assign(metadata, { getSettings: () => STRUCTURED_PREFERENCE })
    )
    const params = createLaunch({
      operationId: OPERATION_ID,
      surface: 'chat',
      sessionId: 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d',
      paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      createIdentity: { instanceId }
    })
    const { createIdentity: _identity, ...old } = params
    expect(computeAgentLaunchFingerprint(old)).toBe(
      computeAgentLaunchFingerprint({ ...old, createIdentity: undefined })
    )
    expect(computeAgentLaunchFingerprint(params)).not.toBe(computeAgentLaunchFingerprint(old))
    expect(AGENT_LAUNCH.params.safeParse({ ...params, operationId: undefined }).success).toBe(false)
    expect(
      AGENT_LAUNCH.params.safeParse({ ...params, target: { kind: 'existing', worktree: 'wt' } })
        .success
    ).toBe(false)
    let release!: () => void
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.createManagedWorktree.mockImplementationOnce(async (args) => {
      expect(args.requestedInstanceId).toBe(instanceId)
      started()
      await gate
      return { worktree: { id: 'wt-new' }, startupTerminal: undefined }
    })
    const first = launch(params, runtime)
    await reached
    const joined = launch(params, runtime)
    await expect(
      launch(
        { ...params, createIdentity: { instanceId: '9ccecb73-d0bf-470a-88ac-d20ff63972ad' } },
        runtime
      )
    ).rejects.toThrow('agent_session_operation_conflict')
    const other = (suffix: string) => ({
      ...params,
      operationId: `${NOW}-${suffix.padStart(32, '0')}`
    })
    await expect(launch(other('ab'), runtime)).rejects.toThrow(
      'Workspace identity is already in use.'
    )
    release()
    expect(await joined).toEqual(await first)
    const key = canonicalWorktreeIdentity({
      worktreeId: 'unlisted',
      executionHostId: 'local',
      instanceId
    })
    state.worktreeMetaByIdentity = { [key]: { ...metadataRow(instanceId), hostId: 'local' } }
    await expect(launch(other('ac'), runtime)).rejects.toThrow(
      'Workspace identity is already in use.'
    )
    delete state.worktreeMetaByIdentity[key]
    state.worktreeMeta['legacy'] = metadataRow(instanceId)
    await expect(launch(other('ad'), runtime)).rejects.toThrow(
      'Workspace identity is already in use.'
    )
    delete state.worktreeMeta['legacy']
    await launch(other('ae'), runtime)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
  })

  it('joins an identical live retry through settlement and conflicts on changed intent', async () => {
    const runtime = runtimeStub()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseEffect: (() => void) | undefined
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve
    })
    runtime.createManagedWorktree.mockImplementationOnce(async () => {
      markStarted?.()
      await effectGate
      return { worktree: { id: 'wt-new' }, startupTerminal: undefined }
    })
    const params = createLaunch({ operationId: OPERATION_ID })
    const first = launch(params, runtime)
    await started
    const joined = launch(params, runtime)
    await expect(
      launch(createLaunch({ operationId: OPERATION_ID, agent: 'codex' }), runtime)
    ).rejects.toThrow('agent_session_operation_conflict')
    releaseEffect?.()
    const [firstResult, joinedResult] = await Promise.all([first, joined])

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(joinedResult).toEqual(firstResult)
  })

  it('the atomic claim admits exactly one winner where the blind settle admitted two', async () => {
    await store.admitOperation({
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      fingerprint: 'fp-1',
      now: NOW
    })

    const claims = await Promise.all([
      store.claimOperation({ callerKey: 'device-1', operationId: OPERATION_ID }),
      store.claimOperation({ callerKey: 'device-1', operationId: OPERATION_ID })
    ])
    expect(claims.filter((claim) => claim.claim === 'won')).toHaveLength(1)
    expect(claims.filter((claim) => claim.claim === 'lost')).toHaveLength(1)
  })
})

describe('a fresh launch writes the ledger once before its effect', () => {
  it('admits and claims in one durable transaction, claimed on disk when the effect starts', async () => {
    const admitAndClaim = vi.spyOn(store, 'admitAndClaimOperation')
    const admit = vi.spyOn(store, 'admitOperation')
    const claimOnly = vi.spyOn(store, 'claimOperation')
    const runtime = runtimeStub()
    let statusAtEffect: string | undefined
    runtime.createManagedWorktree.mockImplementationOnce(async () => {
      const persisted = await readPersistedTestAgentSessionStore(directory)
      statusAtEffect =
        persisted.operations[agentSessionOperationKey('device-1', OPERATION_ID)]?.outcome.status
      return { worktree: { id: 'wt-new' }, startupTerminal: undefined }
    })

    await launch(createLaunch({ operationId: OPERATION_ID }), runtime)

    expect(admitAndClaim).toHaveBeenCalledTimes(1)
    expect(admit).not.toHaveBeenCalled()
    expect(claimOnly).not.toHaveBeenCalled()
    // A claim moves the row from `pending` to `unknown`: taken, not yet settled.
    expect(statusAtEffect).toBe('unknown')
  })

  it('still lets exactly one of two concurrent admissions run the effect', async () => {
    const admission = {
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      fingerprint: 'fp-1',
      now: NOW
    }
    const claimAfter = (decision: { decision: string; row?: AgentSessionOperationRow }) =>
      decision.decision === 'admit' ||
      (decision.decision === 'replay' && decision.row?.outcome.status === 'pending')

    const results = await Promise.all([
      store.admitAndClaimOperation(admission, claimAfter),
      store.admitAndClaimOperation(admission, claimAfter)
    ])

    expect(results.filter((result) => result.claim?.claim === 'won')).toHaveLength(1)
  })
})

describe('stable replay identity', () => {
  it('replays across a bearer-credential change under the paired device subject', async () => {
    const params = createLaunch({ operationId: OPERATION_ID })
    const firstRuntime = runtimeStub()
    const first = await launch(params, firstRuntime, PAIRED_CLIENT)
    const replayRuntime = runtimeStub()

    await expect(launch(params, replayRuntime, ROTATED_CREDENTIAL_CLIENT)).resolves.toEqual(first)
    expect(firstRuntime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(replayRuntime.createManagedWorktree).not.toHaveBeenCalled()
    expect(attachCallerKeys).toEqual(['device-1'])
  })

  it('refuses remote replay safety without a stable paired-device subject', async () => {
    const runtime = runtimeStub()

    await expect(
      launch(createLaunch({ operationId: OPERATION_ID }), runtime, {
        clientKind: 'runtime',
        clientId: 'rotating-credential',
        clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
      })
    ).rejects.toThrow('agent_session_identity_required')
    expect(runtime.ensureStructuredAgentSessionHost).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(store.listOperationRows()).toHaveLength(0)
  })
})

describe('a replay answers from the record', () => {
  it('returns the whole recorded result rather than recomputing it', async () => {
    const runtime = runtimeStub({ createWarning: 'Could not copy untracked files.' })
    const params = createLaunch({
      operationId: OPERATION_ID,
      prompt: { text: 'go', delivery: 'draft' }
    })
    const first = await launch(params, runtime)

    // The settings that produced the receipt move underneath the replay. A recomputed answer would
    // now say the user prefers a terminal; the recorded one still says what actually ran.
    const movedSettings = runtimeStub({
      settings: {
        experimentalNativeChat: false
      }
    })
    const replayed = await launch(params, movedSettings, PAIRED_CLIENT)

    expect(replayed).toEqual(first)
    expect(replayed.receipt.preferred).toBe('structured')
    expect(replayed.warning).toBe('Could not copy untracked files.')
    expect(replayed.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(movedSettings.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('survives a host restart, because the record is on disk', async () => {
    const runtime = runtimeStub()
    const params = createLaunch({ operationId: OPERATION_ID })
    const first = await launch(params, runtime)

    const reopened = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(reopened)
    const afterRestart = runtimeStub()

    expect(await launch(params, afterRestart)).toEqual(first)
    expect(afterRestart.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('refuses a retry that changed what it asks for, and creates nothing', async () => {
    const runtime = runtimeStub()
    await launch(createLaunch({ operationId: OPERATION_ID }), runtime)

    const conflicting = runtimeStub()
    await expect(
      launch(
        createLaunch({
          operationId: OPERATION_ID,
          target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'other' } }
        }),
        conflicting
      )
    ).rejects.toThrow('agent_session_operation_conflict')
    expect(conflicting.createManagedWorktree).not.toHaveBeenCalled()
    expect(conflicting.createTerminal).not.toHaveBeenCalled()
  })
})

describe('an uncertain launch stays uncertain', () => {
  it('refuses an operation left at unknown, and never falls back to launching again', async () => {
    const params = createLaunch({ operationId: OPERATION_ID })
    await store.admitOperation({
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      // The host's own digest, so the retry passes the fingerprint check and is refused for the
      // reason under test rather than for disagreeing about what it asked for.
      fingerprint: computeAgentLaunchFingerprint(params),
      now: NOW
    })
    await store.claimOperation({ callerKey: 'device-1', operationId: OPERATION_ID })

    const runtime = runtimeStub()
    await expect(launch(params, runtime)).rejects.toThrow('agent_session_operation_unknown')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('leaves the row at unknown when the launch itself throws past the claim', async () => {
    const runtime = runtimeStub()
    runtime.createManagedWorktree.mockRejectedValueOnce(new Error('worktree_create_failed'))

    await expect(launch(createLaunch({ operationId: OPERATION_ID }), runtime)).rejects.toThrow(
      'worktree_create_failed'
    )
    expect(rowFor(OPERATION_ID)?.outcome.status).toBe('unknown')
  })

  it('preserves the unknown refusal code through RPC dispatch', async () => {
    const params = createLaunch({ operationId: OPERATION_ID })
    await store.admitOperation({
      callerKey: 'trusted-local:runtime',
      operationId: OPERATION_ID,
      fingerprint: computeAgentLaunchFingerprint(params),
      now: NOW
    })
    await store.claimOperation({
      callerKey: 'trusted-local:runtime',
      operationId: OPERATION_ID
    })
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'agent.launch',
      params
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent_session_operation_unknown',
        message: 'agent_session_operation_unknown'
      }
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('records a failure that happened before anything could be created', async () => {
    const runtime = runtimeStub()
    runtime.showTerminalWorkspaceLaunchScope.mockRejectedValueOnce(new Error('worktree_not_found'))

    await expect(
      launch(
        createLaunch({ operationId: OPERATION_ID, target: { kind: 'existing', worktree: 'gone' } }),
        runtime
      )
    ).rejects.toThrow('worktree_not_found')
    expect(rowFor(OPERATION_ID)?.outcome).toMatchObject({
      status: 'failed',
      code: 'worktree_not_found'
    })
  })
})

describe('settlement is monotone', () => {
  it('does not let a late unknown clobber a recorded success', () => {
    const succeeded: AgentSessionOperationRow = {
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      fingerprint: 'fp-1',
      operationTimestamp: NOW,
      recordedAt: NOW,
      expiresAt: NOW + 1,
      outcome: { status: 'succeeded', sessionId: 'sess-1' }
    }
    const rows = new Map([[agentSessionOperationKey('device-1', OPERATION_ID), succeeded]])

    const settled = settleAgentSessionOperation(rows, {
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      outcome: { status: 'unknown' }
    })

    expect([...settled.values()][0].outcome).toEqual({ status: 'succeeded', sessionId: 'sess-1' })
  })

  it('still lets a claim take a pending row, which is the one state it may take', () => {
    const pending: AgentSessionOperationRow = {
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      fingerprint: 'fp-1',
      operationTimestamp: NOW,
      recordedAt: NOW,
      expiresAt: NOW + 1,
      outcome: { status: 'pending' }
    }
    const rows = new Map([[agentSessionOperationKey('device-1', OPERATION_ID), pending]])

    const claimed = claimAgentSessionOperation(rows, {
      callerKey: 'device-1',
      operationId: OPERATION_ID
    })

    expect(claimed.claim.claim).toBe('won')
    expect([...claimed.rows.values()][0].outcome).toEqual({ status: 'unknown' })
  })
})

describe('the recorded row stays readable by a build that predates it', () => {
  it('writes a launch success as a succeeded row with a string sessionId', async () => {
    // A terminal launch: the surface has a handle and no session id, which is the case that would
    // tempt a new outcome status or an optional field.
    await launch(
      createLaunch({
        agent: 'codex',
        operationId: OPERATION_ID,
        target: { kind: 'existing', worktree: 'id:wt-7' }
      }),
      runtimeStub({ createSupport: { supported: false, reason: 'agent' } })
    )

    const file: { operations: Record<string, { outcome: Record<string, unknown> }> } =
      await readPersistedTestAgentSessionStore(directory)
    const outcome = Object.values(file.operations)[0].outcome

    // The ratchet, and the reason this is not a new status arm or an optional `sessionId`: a build
    // without `launch` validates a row by these two fields and drops a row it rejects, losing its
    // replay. A downgrade must skip only what it cannot understand.
    expect(outcome.status).toBe('succeeded')
    expect(typeof outcome.sessionId).toBe('string')
    expect(outcome.launch).toMatchObject({ outcome: { kind: 'terminal' } })
  })
})

describe('an unreadable launch payload costs one replay, never the store', () => {
  /** The recorded operation row, as a build that wrote another payload shape leaves it. */
  async function rewriteRecordedLaunch(payload: unknown): Promise<void> {
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      const row: { outcome: Record<string, unknown> } = Object.values(persisted.operations)[0]
      row.outcome.launch = payload
    })
  }

  it('still admits the row, because a load drops a row it rejects', () => {
    // The ratchet. `isAgentLaunchResult` mirrors a result type by hand, so a field tightened there
    // would reject rows this same build wrote and lose their replay.
    expect(
      isAgentSessionOperationRow({
        callerKey: 'device-1',
        operationId: OPERATION_ID,
        fingerprint: 'fp-1',
        operationTimestamp: NOW,
        recordedAt: NOW,
        expiresAt: NOW + 1,
        outcome: { status: 'succeeded', sessionId: 'sess-1', launch: { not: 'a launch result' } }
      })
    ).toBe(true)
  })

  it('reopens the store and refuses only the operation whose payload it cannot read', async () => {
    const runtime = runtimeStub()
    const params = createLaunch({ operationId: OPERATION_ID })
    await launch(params, runtime)
    await rewriteRecordedLaunch({ outcome: { kind: 'structured' }, worktreeId: 'wt-1' })

    const reopened = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(reopened)

    expect(reopened.listOperationRows()).toHaveLength(1)
    const retry = runtimeStub()
    await expect(launch(params, retry)).rejects.toThrow('agent_session_operation_unknown')
    expect(retry.createManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('a recorded failure replays as the failure it was', () => {
  it('answers with the code the launch actually raised, not the ledger vocabulary', async () => {
    const runtime = runtimeStub()
    runtime.showTerminalWorkspaceLaunchScope.mockRejectedValue(new Error('worktree_not_found'))
    const params = createLaunch({
      operationId: OPERATION_ID,
      target: { kind: 'existing', worktree: 'gone' }
    })
    await expect(launch(params, runtime)).rejects.toThrow('worktree_not_found')

    // `worktree_not_found` is not in AGENT_SESSION_WIRE_REFUSAL_CODES. Narrowing the recorded code
    // through that closed list answers `agent_session_operation_invalid` — the ledger's "your id is
    // malformed" signal, which tells a client to mint a fresh id when the truthful answer is that
    // this launch definitively did not run.
    const replayed = runtimeStub()
    replayed.showTerminalWorkspaceLaunchScope.mockRejectedValue(new Error('worktree_not_found'))
    await expect(launch(params, replayed)).rejects.toThrow('worktree_not_found')
    expect(replayed.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
  })

  it('bounds the code it persists, because a code is an identifier and a message is not', async () => {
    const runtime = runtimeStub()
    runtime.showTerminalWorkspaceLaunchScope.mockRejectedValue(
      new Error(`ENOENT: no such file or directory, stat '${'/very/long/path'.repeat(400)}'`)
    )

    await expect(
      launch(
        createLaunch({ operationId: OPERATION_ID, target: { kind: 'existing', worktree: 'gone' } }),
        runtime
      )
    ).rejects.toThrow('ENOENT')

    const outcome = rowFor(OPERATION_ID)?.outcome
    if (outcome?.status !== 'failed') {
      throw new Error('the pre-execution failure must record a failed row')
    }
    expect(outcome.code.length).toBeLessThanOrEqual(128)
  })
})

describe('a client that names no operation keeps today behaviour', () => {
  it('runs the launch and writes no ledger row at all', async () => {
    const runtime = runtimeStub()
    await launch(createLaunch(), runtime)

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(store.listOperationRows()).toHaveLength(0)
  })

  it('still dedupes a repeated create through the in-memory mutation-id cache', async () => {
    const runtime = runtimeStub()
    const params = createLaunch({
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:repo-1', name: 'task', clientMutationId: 'launch-1' }
      }
    })

    const [first, second] = await Promise.all([launch(params, runtime), launch(params, runtime)])

    expect(first).toEqual(second)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(store.listOperationRows()).toHaveLength(0)
  })
})

describe('the inner attach reserves under its own id', () => {
  it('does not conflict with its own launch when both share a caller key', async () => {
    const runtime = runtimeStub()
    const params = createLaunch({
      operationId: OPERATION_ID,
      target: { kind: 'existing', worktree: 'id:wt-7' }
    })

    const result = await launch(params, runtime, PAIRED_CLIENT)

    expect(result.outcome).toEqual({
      kind: 'structured',
      sessionId: 'sess-1',
      handle: expect.any(String)
    })
    expect(attachOperationIds).toHaveLength(1)
    expect(attachOperationIds[0]).not.toBe(OPERATION_ID)
    expect(attachOperationIds[0]).toBe(deriveAgentLaunchChildOperationId(OPERATION_ID))
    expect(attachCallerKeys).toEqual(['device-1'])
  })

  it('what forwarding the launch id unchanged would do: the attach refuses a conflict', async () => {
    const callerKey = 'client-9'
    await store.admitOperation({
      callerKey,
      operationId: OPERATION_ID,
      fingerprint: 'launch-fingerprint',
      now: NOW
    })

    // What the attach does with whatever id it is handed: reserve in the same ledger, under the
    // same caller, with its own attach fingerprint.
    const forwarded = await store.admitOperation({
      callerKey,
      operationId: OPERATION_ID,
      fingerprint: 'attach-fingerprint',
      now: NOW
    })
    expect(forwarded).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
    })

    const derived = deriveAgentLaunchChildOperationId(OPERATION_ID)
    if (derived === null) {
      throw new Error('the launch id must derive a child id')
    }
    const child = await store.admitOperation({
      callerKey,
      operationId: derived,
      fingerprint: 'attach-fingerprint',
      now: NOW
    })
    expect(child.decision).toBe('admit')
  })
})

it('carries only an actual resolved workspace on negotiated desktop errors and preserves the older mapped refusal', async () => {
  const desktopCapability = 'agent.launch.desktop-create.v1'
  const replay = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
  const runtime = runtimeStub()
  const metadata = getDefaultPersistedState('/fixture')
  const owner = metadataOwner(metadata)
  runtime.requireStore.mockReturnValue(
    Object.assign(owner, { getSettings: () => STRUCTURED_PREFERENCE })
  )
  runtime.createManagedWorktree.mockImplementation(async (args) => {
    if (typeof args.initializeSurface !== 'function') {
      throw new Error('missing real initialization seam')
    }
    await args.initializeSurface({
      worktreeId: 'wt-resolved',
      workspacePath: '/actual/workspace',
      startupTerminalHandle: undefined
    })
    throw new Error('post-resolution bookkeeping failed')
  })
  const params = replay.params.parse(
    createLaunch({
      operationId: `${NOW}-0000000000000000000000000000e001`,
      surface: 'chat',
      sessionId: 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d',
      paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      createIdentity: { instanceId: '94d38a16-e9db-4e86-b81d-334788958124' }
    })
  )
  const { mapRuntimeError } = await import('../errors')
  const invoke = async (operationId: string, clientCapabilities: string[]) => {
    try {
      await replay.handler(
        { ...params, operationId },
        rpcContext(runtime, { ...PAIRED_CLIENT, clientCapabilities })
      )
      throw new Error('expected execution to fail')
    } catch (error) {
      return mapRuntimeError('desktop', { runtimeId: 'fixture' }, error)
    }
  }
  const modern = await invoke(params.operationId, [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    desktopCapability
  ])
  expect(modern).toMatchObject({
    ok: false,
    error: {
      code: 'agent_session_operation_unknown',
      message: 'agent_session_operation_unknown',
      data: { desktopCreate: { worktreeId: 'wt-resolved' } }
    }
  })
  const older = await invoke(`${NOW}-0000000000000000000000000000e002`, [
    AGENT_LAUNCH_RUNTIME_CAPABILITY
  ])
  expect(older).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_unknown', message: 'agent_session_operation_unknown' }
  })
  if (older.ok) {
    throw new Error('expected mapped error')
  }
  expect(older.error).not.toHaveProperty('data')
  runtime.createManagedWorktree.mockRejectedValueOnce(new Error('before actual workspace'))
  const before = await invoke(`${NOW}-0000000000000000000000000000e003`, [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    desktopCapability
  ])
  if (before.ok) {
    throw new Error('expected unresolved create')
  }
  expect(before.error).not.toHaveProperty('data')
})

it('bounds active instance admission and legacy ownership scans by their actual N/10N populations', async () => {
  const counts: number[][] = []
  for (const size of [10, 100]) {
    const state = getDefaultPersistedState('/fixture')
    let legacyReads = 0
    for (let i = 0; i < size; i++) {
      Object.defineProperty(state.worktreeMeta, `legacy-${i}`, {
        enumerable: true,
        get: () => {
          legacyReads++
          return { instanceId: `legacy-${i}` }
        }
      })
    }
    const owner = metadataOwner(state)
    const runtime = runtimeStub()
    runtime.requireStore.mockReturnValue(
      Object.assign(owner, { getSettings: () => STRUCTURED_PREFERENCE })
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    let allStarted!: () => void
    const reached = new Promise<void>((resolve) => {
      allStarted = resolve
    })
    runtime.createManagedWorktree.mockImplementation(async () => {
      started++
      if (started === size) {
        allStarted()
      }
      await gate
      return { worktree: { id: `wt-${started}` }, startupTerminal: undefined }
    })
    let activeVisits = 0
    const values = Map.prototype.values
    const walk = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
      this: Map<unknown, unknown>
    ) {
      for (const value of values.call(this)) {
        if (
          value &&
          typeof value === 'object' &&
          'hostFoundingAttempt' in value &&
          'fingerprint' in value
        ) {
          activeVisits++
        }
        yield value
      }
      return undefined
    })
    const flights = Array.from({ length: size }, (_, i) => {
      const suffix = (size * 1000 + i).toString(16).padStart(12, '0')
      return launch(
        createLaunch({
          operationId: `${NOW}-${suffix.padStart(32, '0')}`,
          surface: 'chat',
          sessionId: `claude_00000000_0000_4000_8000_${suffix}`,
          paneKey: `00000000-0000-4000-8000-${suffix}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`,
          createIdentity: { instanceId: `00000000-0000-4000-8000-${suffix}` }
        }),
        runtime
      )
    })
    try {
      await reached
      expect(legacyReads).toBeLessThanOrEqual(size * size)
      expect(activeVisits).toBeLessThanOrEqual(size * size)
      counts.push([size, legacyReads, activeVisits])
    } finally {
      walk.mockRestore()
      release()
      await Promise.all(flights)
    }
  }
  console.info(
    'identity admission [population, legacy reads, active visits]',
    JSON.stringify(counts)
  )
})
