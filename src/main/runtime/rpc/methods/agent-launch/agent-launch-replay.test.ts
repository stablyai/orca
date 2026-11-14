import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
/** Exercise at-most-once launch and truthful replay against the durable ledger; adjacent ablations prove each guard prevents duplication. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  computeAgentLaunchFingerprint,
  type AgentLaunchFingerprintInput
} from '../../../../../shared/agent-launch/contracts/agent-launch-operation'
import {
  agentSessionOperationKey,
  settleAgentSessionOperation,
  type AgentSessionOperationRow
} from '../../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcContext } from '../../core'
import '../../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import '../../dispatcher'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

type StructuredCreateReply =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; refusal: { code: string; message: string } }

/** Record attach operation ids to verify the child-id rule directly. */
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

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: {
    caller: { callerKey: string }
    envelope: { clientOperationId: string }
  }) => createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')

const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

// Use current time because admission rejects operation ids outside its clock window.
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
  store = await openTestAgentSessionRecordStore(directory)
  // The ledger alone, as admission opens it: no chat host is installed.
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
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

    // Changed settings must not recompute the recorded launch receipt.
    const movedSettings = runtimeStub({
      settings: { nativeChatProviders: { claude: false, codex: false } }
    })
    const replayed = await launch(params, movedSettings, PAIRED_CLIENT)

    expect(replayed).toEqual(first)
    expect(replayed.receipt.preferred).toBe('structured')
    expect(replayed.warning).toBe('Could not copy untracked files.')
    expect(replayed.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(movedSettings.createManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('an uncertain launch stays uncertain', () => {
  it('refuses an operation left at unknown, and never falls back to launching again', async () => {
    const params = createLaunch({ operationId: OPERATION_ID })
    await store.admitOperation({
      callerKey: 'device-1',
      operationId: OPERATION_ID,
      // Use the host's digest so admission tests the intended refusal, not a fingerprint mismatch.
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
})

describe('an unreadable launch payload costs one replay, never the store', () => {
  /** The recorded operation row, as a build that wrote another payload shape leaves it. */
  async function rewriteRecordedLaunch(payload: unknown): Promise<void> {
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      const row: { outcome: Record<string, unknown> } = Object.values(persisted.operations)[0]
      row.outcome.launch = payload
    })
  }

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

    // Keep worktree_not_found verbatim: narrowing to agentSession codes would falsely report an invalid id and invite a duplicate attempt.
    const replayed = runtimeStub()
    replayed.showTerminalWorkspaceLaunchScope.mockRejectedValue(new Error('worktree_not_found'))
    await expect(launch(params, replayed)).rejects.toThrow('worktree_not_found')
    expect(replayed.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
  })
})
