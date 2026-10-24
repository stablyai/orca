import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'
import { RpcDispatcher } from '../dispatcher'
import type { RpcCallerIdentity } from '../rpc-caller-identity'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { createTestParams } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  HOST_TEST_NOW as NOW,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { loadTestJournal } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { JournalRowWriter } from '../../../native-chat/agent-session-journal/journal-row-writer'
import * as reducer from '../../../native-chat/agent-session-journal/journal-reducer'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import { AGENT_LAUNCH_CANCELLED_CODE } from '../../../../shared/agent-launch-cancellation'
import { AgentLaunchCancel } from '../../../../shared/rpc-contract/agent-launch-params'
import type { OrcaRuntimeService } from '../../orca-runtime'

const SESSION = 'codex_cancel_contract'
const cancel = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchCancel')
let rig: RestTestRig
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  rig = await createRestTestRig({
    setupHold: () => new Promise(() => {}),
    idleSweep: { intervalMs: 60_000 }
  })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

function harness(
  prompt: { text: string; delivery: 'submit' | 'draft' } | null = { text: 'A', delivery: 'submit' }
) {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const setup = vi.fn()
  const published = vi.fn(async () => {})
  const runtime = {
    ...runtimeStub(),
    getRuntimeId: () => 'runtime-1',
    openAgentSessionRecordStore: vi.fn(async () => rig.store),
    openedAgentSessionRecordStore: vi.fn(() => rig.store),
    resolveStructuredAgentSessionCreateIntent: async (input: { envelope: unknown }) => ({
      ...createTestParams(),
      envelope: input.envelope
    }),
    publishStructuredAgentSessionTab: published
  }
  runtime.createManagedWorktree.mockImplementation(async (args) => {
    args.onWorkspaceCreated?.('workspace-1')
    await args.initializeSurface?.({
      worktreeId: 'workspace-1',
      workspacePath: '/task',
      startupTerminalHandle: undefined
    })
    setup()
    entered.resolve()
    await finish.promise
    return { worktree: { id: 'workspace-1', path: '/task' }, startupTerminal: undefined }
  })
  const context = rpcContext(runtime, {
    caller: { kind: 'desktop' },
    pairedDeviceId: 'desktop-device',
    clientKind: 'runtime',
    clientCapabilities: ['agent.launch.v2', 'agent.launch.prompt-unconfirmed.v1']
  })
  // SAFETY: real handler/ledger/host/journal execute; only workspace/provider/presentation ports are scripted.
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: AGENT_LAUNCH_METHODS
  })
  const params = AgentLaunchCancel.parse({
    operationId: hostTestOperationId(),
    agent: 'codex',
    sessionId: SESSION,
    paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e',
    surface: 'chat',
    target: { kind: 'create-worktree', create: { repo: 'repo-1', name: 'task' } },
    ...(prompt ? { prompt } : {}),
    agentArgs: ''
  })
  const call = (
    method: string,
    payload = params,
    caller: RpcCallerIdentity = { kind: 'desktop' }
  ) =>
    dispatcher.dispatch(
      { id: 'request-1', authToken: 'test-token', method, params: payload },
      {
        caller,
        pairedDeviceId: 'desktop-device',
        clientKind: 'runtime',
        clientCapabilities: ['agent.launch.v2', 'agent.launch.prompt-unconfirmed.v1']
      }
    )
  return { runtime, params, call, context, entered, finish, setup, published }
}

it('durably fences an overtaking cancel and same frozen Replay without workspace or input effects', async () => {
  const h = harness()
  h.params.createIdentity = { instanceId: '724a8e17-fd06-4f61-a168-c268746bd3e9' }
  expect(AgentLaunchCancel.safeParse({ ...h.params, cwd: '/other' }).success).toBe(false)
  expect(
    AgentLaunchCancel.safeParse({
      ...h.params,
      target: { kind: 'existing', worktree: 'id:workspace-1' }
    }).success
  ).toBe(false)
  const opening = h.runtime.openAgentSessionRecordStore.mockImplementationOnce(async () => {
    await gate.promise
    return rig.store
  })
  const gate = Promise.withResolvers<void>()
  const cancellation = h.call('agent.launchCancel')
  await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
  const launch = h.call('agent.launchReplay')
  gate.resolve()
  expect(await cancellation).toMatchObject({ ok: true, result: { status: 'cancelled' } })
  expect(await launch).toMatchObject({ ok: false, error: { code: AGENT_LAUNCH_CANCELLED_CODE } })
  expect(await h.call('agent.launchReplay')).toMatchObject({
    ok: false,
    error: { code: AGENT_LAUNCH_CANCELLED_CODE }
  })
  expect(
    await h.call('agent.launchCancel', { ...h.params, agentArgs: '--model other' })
  ).toMatchObject({ ok: false, error: { code: 'agent_session_operation_conflict' } })
  expect(
    await h.call('agent.launchCancel', {
      ...h.params,
      createIdentity: { instanceId: 'fa48e1a0-2bd7-44e2-8f37-2636a6dab793' }
    })
  ).toMatchObject({ ok: false, error: { code: 'agent_session_operation_conflict' } })
  expect(h.runtime.createManagedWorktree).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)).toBeNull()
  const row = rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)
  expect(row).toMatchObject({
    fingerprint: computeAgentLaunchFingerprint(h.params),
    outcome: { status: 'failed', code: AGENT_LAUNCH_CANCELLED_CODE }
  })
  const restarted = await rig.restart()
  expect(restarted).toBeDefined()
  expect(rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)).toEqual(row)
  const replay = await h.call('agent.launchCancel')
  expect(replay, JSON.stringify(replay)).toMatchObject({
    ok: true,
    result: { status: 'cancelled' }
  })
  expect(
    await h.call('agent.launchCancel', h.params, {
      kind: 'paired-device',
      deviceId: 'other-device'
    })
  ).toMatchObject({ ok: true, result: { status: 'cancelled' } })
  expect(rig.store.getOperationRow('other-device', h.params.operationId)?.fingerprint).toBe(
    computeAgentLaunchFingerprint(h.params)
  )
  expect(rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)).toEqual(row)
  await expect(
    cancel.handler(h.params, { ...h.context, caller: { kind: 'local-cli' } })
  ).rejects.toThrow('forbidden')
})

it.each([
  { text: 'A', delivery: 'submit' as const },
  null,
  { text: 'draft', delivery: 'draft' as const },
  { text: '   ', delivery: 'submit' as const }
])(
  'checks the final real founding receipt after delayed append/blank, retaining setup with zero chat/input: %j',
  async (prompt) => {
    const h = harness(prompt)
    const waiting = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const commit = rig.store.commitOperationReceipt.bind(rig.store)
    vi.spyOn(rig.store, 'commitOperationReceipt').mockImplementation(async (proof) => {
      waiting.resolve()
      await proceed.promise
      return commit(proof)
    })
    const enqueue = JournalRowWriter.prototype.enqueueRows
    vi.spyOn(JournalRowWriter.prototype, 'enqueueRows').mockImplementation(function (
      this: JournalRowWriter,
      plan,
      proof,
      receiptRow
    ) {
      if (!proof) {
        return enqueue.call(this, plan, proof, receiptRow)
      }
      waiting.resolve()
      return proceed.promise.then(() => enqueue.call(this, plan, proof, receiptRow))
    })
    const launch = h.call('agent.launchReplay')
    await Promise.race([
      waiting.promise,
      launch.then((result) => {
        throw new Error(JSON.stringify(result))
      })
    ])
    expect(await h.call('agent.launchCancel')).toMatchObject({
      ok: true,
      result: { status: 'cancelled' }
    })
    proceed.resolve()
    await Promise.race([
      h.entered.promise,
      launch.then((result) => {
        throw new Error(JSON.stringify(result))
      })
    ])
    h.finish.resolve()
    expect(await launch).toMatchObject({ ok: false, error: { code: AGENT_LAUNCH_CANCELLED_CODE } })
    expect(h.setup).toHaveBeenCalledOnce()
    expect(h.runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.published).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size ?? 0).toBe(0)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('keeps positive COMMIT through a failed fold and progress cancel, then ordinary B opens durable A', async () => {
  const h = harness()
  const apply = reducer.applyJournalRow
  let injected = false
  vi.spyOn(reducer, 'applyJournalRow').mockImplementation((state, row, at) => {
    if (!injected && row.kind === 'submission') {
      injected = true
      throw new Error('postcommit fold fault')
    }
    return apply(state, row, at)
  })
  const launch = h.call('agent.launchReplay')
  await Promise.race([
    h.entered.promise,
    launch.then((result) => {
      throw new Error(JSON.stringify(result))
    })
  ])
  const result = await h.call('agent.launchCancel')
  expect(result).toMatchObject({
    ok: true,
    result: { status: 'admitted', surfaceAdmitted: true, messageId: expect.any(String) }
  })
  expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(1)
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  const record = rig.store.getRecord(SESSION)
  expect(record).toBeDefined()
  const next = restTestSend('B', record?.lease.runtimeFence)
  const sent = await rig.host.send(
    { callerKey: 'ordinary' },
    {
      ...next,
      envelope: {
        ...next.envelope,
        sessionId: SESSION,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body: next.body }
        })
      }
    }
  )
  expect(sent.ok).toBe(true)
  expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(2)
  h.finish.resolve()
  expect(await launch).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_unknown' }
  })
})

it('keeps a failed-persistence cancel fence on the same owner without certifying cancellation or executing Retry', async () => {
  const h = harness()
  vi.spyOn(rig.store, 'cancelLaunchOperation').mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await h.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'unknown' }
  })
  expect(await h.call('agent.launchReplay')).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_unknown' }
  })
  expect(await h.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'unknown' }
  })
  expect(rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)).toBeNull()
  expect(h.runtime.createManagedWorktree).not.toHaveBeenCalled()
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()

  const live = harness()
  const support = Promise.withResolvers<{ supported: boolean; reason: 'agent' }>()
  live.runtime.getStructuredAgentSessionCreateSupport.mockReturnValueOnce(support.promise)
  const original = live.call('agent.launchReplay')
  await vi.waitFor(() =>
    expect(live.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledOnce()
  )
  vi.mocked(rig.store.cancelLaunchOperation).mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await live.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'unknown' }
  })
  support.resolve({ supported: false, reason: 'agent' })
  await Promise.race([
    live.entered.promise,
    original.then((result) => {
      throw new Error(JSON.stringify(result))
    })
  ])
  live.finish.resolve()
  expect(await original).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_unknown' }
  })
  expect(await live.call('agent.launchReplay')).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_unknown' }
  })
  expect(live.setup).toHaveBeenCalledOnce()
  expect(live.runtime.createManagedWorktree).toHaveBeenCalledOnce()
  expect(live.runtime.createTerminal).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)).toBeNull()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('prevents late downgrade before dispatch while retaining requested workspace setup', async () => {
  const h = harness()
  const support = Promise.withResolvers<{ supported: boolean; reason: 'agent' }>()
  h.runtime.getStructuredAgentSessionCreateSupport.mockReturnValueOnce(support.promise)
  const launch = h.call('agent.launchReplay')
  await vi.waitFor(() =>
    expect(h.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledOnce()
  )
  expect(await h.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'cancelled' }
  })
  support.resolve({ supported: false, reason: 'agent' })
  await Promise.race([
    h.entered.promise,
    launch.then((result) => {
      throw new Error(JSON.stringify(result))
    })
  ])
  h.finish.resolve()
  expect(await launch).toMatchObject({ ok: false, error: { code: AGENT_LAUNCH_CANCELLED_CODE } })
  expect(h.setup).toHaveBeenCalledOnce()
  expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)).toBeNull()
})

it('keeps dispatched terminal uncertainty without aborting its one spawn or carried input', async () => {
  const h = harness()
  h.runtime.getStructuredAgentSessionCreateSupport.mockResolvedValue({
    supported: false,
    reason: 'agent'
  })
  const dispatched = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  let signal: unknown
  h.runtime.createTerminal.mockImplementation(async (_selector, options) => {
    signal = options?.signal
    if (typeof options?.onPtySpawnDispatched !== 'function') {
      throw new Error('missing dispatch proof')
    }
    options.onPtySpawnDispatched()
    dispatched.resolve()
    await returned.promise
    if (typeof options.onStartupPromptCarry === 'function') {
      options.onStartupPromptCarry(true)
    }
    return { handle: 'term-1', paneKey: h.params.paneKey }
  })
  h.runtime.getTerminalHandleForPaneKey.mockReturnValue('term-1')
  const launch = h.call('agent.launchReplay')
  await Promise.race([
    dispatched.promise,
    launch.then((result) => {
      throw new Error(JSON.stringify(result))
    })
  ])
  expect(await h.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'unknown' }
  })
  expect(signal).toBeInstanceOf(AbortSignal)
  if (!(signal instanceof AbortSignal)) {
    throw new Error('missing signal')
  }
  expect(signal.aborted).toBe(false)
  returned.resolve()
  await h.entered.promise
  expect(await h.call('agent.launchCancel')).toMatchObject({
    ok: true,
    result: { status: 'admitted', surfaceAdmitted: true }
  })
  h.finish.resolve()
  expect(await launch).toMatchObject({
    ok: true,
    result: {
      outcome: { kind: 'terminal', handle: 'term-1' },
      prompt: { outcome: 'handed-to-terminal' }
    }
  })
  const saved = rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)
  expect(saved?.outcome).toMatchObject({
    status: 'succeeded',
    launch: { outcome: { handle: 'term-1' } }
  })
  h.runtime.getTerminalHandleForPaneKey.mockReturnValue('term-current')
  const storeWaiting = Promise.withResolvers<void>()
  const releaseStore = Promise.withResolvers<void>()
  h.runtime.openAgentSessionRecordStore.mockImplementationOnce(async () => {
    storeWaiting.resolve()
    await releaseStore.promise
    return rig.store
  })
  const lateCancel = h.call('agent.launchCancel')
  await storeWaiting.promise
  const replayHandler = vi.spyOn(methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay'), 'handler')
  const joinedReplay = h.call('agent.launchReplay')
  await vi.waitFor(() => expect(replayHandler).toHaveBeenCalledOnce())
  releaseStore.resolve()
  expect(await lateCancel).toMatchObject({
    ok: true,
    result: {
      status: 'admitted',
      result: { outcome: { kind: 'terminal', handle: 'term-current' } }
    }
  })
  const joined = await joinedReplay
  const after = await h.call('agent.launchReplay')
  expect([joined, after]).toEqual([
    expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        outcome: expect.objectContaining({ handle: 'term-current' })
      })
    }),
    expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        outcome: expect.objectContaining({ handle: 'term-current' })
      })
    })
  ])
  expect(rig.store.getOperationRow('trusted-local:desktop', h.params.operationId)).toEqual(saved)
  expect(h.runtime.createManagedWorktree).toHaveBeenCalledOnce()
  expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
  expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
})
