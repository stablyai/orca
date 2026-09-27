/**
 * Replay safety for `agent.launch`, against the real durable ledger.
 *
 * The property under test is narrow and total: one execution per operation, a recorded answer for
 * every replay, a truthful refusal when the outcome is unknown. Each guard here has an ablation
 * beside it, because a replay test that never watched the unguarded code duplicate is a test of the
 * harness rather than of the guard.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
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
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { agentSessionStorePath } from '../../agent-session-record-store-file'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
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
  store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  // The launch reaches the ledger through the installed host; nothing else on the host is used,
  // because the structured create below it is mocked out.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

describe('exactly one execution per launch operation', () => {
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
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false
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

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see the setup above.
    setStructuredAgentSessionHost({
      deps: { store: reopened }
    } as unknown as StructuredAgentSessionHost)
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

    const file: { operations: Record<string, { outcome: Record<string, unknown> }> } = JSON.parse(
      await readFile(agentSessionStorePath(directory), 'utf-8')
    )
    const outcome = Object.values(file.operations)[0].outcome

    // The ratchet, and the reason this is not a new status arm or an optional `sessionId`: a build
    // without `launch` validates a row by these two fields, one row it rejects returns null for the
    // whole file, and the schema version cannot be bumped to excuse it — a store is unreadable to
    // any build whose version is higher than the file's. A downgrade must skip what it cannot
    // understand, not lose every lease.
    expect(outcome.status).toBe('succeeded')
    expect(typeof outcome.sessionId).toBe('string')
    expect(outcome.launch).toMatchObject({ outcome: { kind: 'terminal' } })
  })
})

describe('an unreadable launch payload costs one replay, never the store', () => {
  /** The whole file, primary and backup: `loadAgentSessionStore` falls through to the backup, and
   *  the backup is a copy of the validated primary, so both carry the same payload in real life. */
  async function rewriteRecordedLaunch(payload: unknown): Promise<void> {
    const path = agentSessionStorePath(directory)
    const file: { operations: Record<string, { outcome: Record<string, unknown> }> } = JSON.parse(
      await readFile(path, 'utf-8')
    )
    const row = Object.values(file.operations)[0]
    row.outcome.launch = payload
    const written = JSON.stringify(file)
    await writeFile(path, written)
    await writeFile(`${path}.bak`, written)
  }

  it('still admits the row, because one rejected row makes the whole file unparseable', () => {
    // The ratchet. `isAgentLaunchResult` mirrors a result type by hand, so a field tightened there
    // would reject rows this same build wrote — and a primary and backup that both fail to parse
    // raise `agent_session_store_corrupt`, taking every lease in the profile with them.
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

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see the setup above.
    setStructuredAgentSessionHost({
      deps: { store: reopened }
    } as unknown as StructuredAgentSessionHost)

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
      code: 'agent_session_operation_conflict'
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
