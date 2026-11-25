import { structuredAgentSessionMessageSendMutation } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { expect, it, vi } from 'vitest'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionInstructionScope } from '../../../../runtime/agent-session/records/agent-session-instruction-scope'
import {
  hostTestSendParams,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  accept,
  acquire,
  dispatch,
  eventually,
  enableBotHome,
  host,
  providerOpen,
  proveOpen,
  publishFirst,
  registerStartupAttemptHostTests,
  restartWith,
  submission,
  CALLER,
  store,
  closeSession,
  proveGeneration
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

async function ownerTask(text: string): Promise<string> {
  const params = hostTestSendParams(text)
  expect(await host.send(CALLER, { ...params, userSend: true })).toMatchObject({ ok: true })
  return params.envelope.clientOperationId
}

async function resumeBot() {
  const seed = await accept('seed a provider rollout')
  await proveOpen()
  await eventually(async () => expect((await submission(seed))?.dispatchState).toBe('accepted'))
  await restartWith(publishFirst, { botHome: true })
  dispatch.mockClear()
}

it('closes A durably at the recovery deadline and a late open cannot send it', async () => {
  await resumeBot()
  const a = await accept('owner task A')
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
  await vi.advanceTimersByTimeAsync(10_000)
  await eventually(async () =>
    expect(await submission(a)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { instructionRecovery: 'timeout', neverReachedAgent: true }
    })
  )
  expect(await host.sendAnswer(SESSION, a, true)).toMatchObject({
    kind: 'rejected',
    submission: {
      clientMessageId: a,
      dispatchState: 'rejected',
      rejection: { instructionRecovery: 'timeout', neverReachedAgent: true }
    }
  })
  expect(
    (await readTestHostJournal(host, SESSION)).items.filter(
      (item) => item.body.kind === 'status' && item.body.failure?.instructionRecovery
    )
  ).toEqual([])
  await proveOpen()
  await host.flushStreamedEvents(SESSION)
  expect(dispatch.mock.calls).toEqual([])
  expect(await submission(a)).toMatchObject({ dispatchState: 'rejected' })
})

it('a new explicit B has its own task identity; a late A cannot open its gate', async () => {
  await resumeBot()
  const a = await ownerTask('retained task')
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
  await vi.advanceTimersByTimeAsync(10_000)
  await eventually(async () => expect((await submission(a))?.dispatchState).toBe('rejected'))
  await proveOpen()
  await eventually(() => expect(acquire.mock.calls.length).toBe(1))
  const original = hostTestSendParams('retained task')
  const b = original.envelope.clientOperationId
  const params = structuredAgentSessionMessageSendMutation({
    sessionId: SESSION,
    clientOperationId: b,
    expectedRuntimeFence: 3,
    body: original.body,
    retryOfClientMessageId: a
  })
  const result = await host.send(CALLER, { ...params, userSend: true })
  expect(result).toMatchObject({ ok: true })
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
  await proveOpen()
  await eventually(async () => expect((await submission(b))?.dispatchState).toBe('accepted'))
  expect(await submission(a)).toMatchObject({ dispatchState: 'rejected' })
  expect(await submission(b)).toMatchObject({
    retryOfClientMessageId: a,
    dispatchState: 'accepted'
  })
  expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([b])
})

it('reacquires an idle warm thread that became a bot home before its first owner task', async () => {
  const seed = await accept('plain thread before bot discovery')
  await proveOpen()
  await eventually(async () => expect((await submission(seed))?.dispatchState).toBe('accepted'))
  enableBotHome()
  dispatch.mockClear()
  const task = await accept('first owner task after bot discovery')
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
  await proveOpen()
  await eventually(async () => expect((await submission(task))?.dispatchState).toBe('accepted'))
  expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([task])
})

it('leaves an admitted task accepted when the recovery clock later expires', async () => {
  await resumeBot()
  const a = await accept('task wins the admission race')
  await proveOpen()
  await eventually(async () => expect((await submission(a))?.dispatchState).toBe('accepted'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await submission(a)).toMatchObject({ dispatchState: 'accepted' })
  expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([a])
})

it('does not preempt an accepted active turn to replace a warm binding', async () => {
  const a = await accept('accepted active task')
  await proveOpen()
  await eventually(async () => expect((await submission(a))?.dispatchState).toBe('accepted'))
  acquire.mock.calls
    .at(-1)![0]
    .events!.appendItem(
      { provider: 'codex', threadId: 'thread-alpha', turnId: 'working', ordinal: 50 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await host.flushStreamedEvents(SESSION)
  enableBotHome()
  const b = hostTestSendParams('new task while policy is outgrown')
  expect(await host.send(CALLER, b)).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await submission(a)).toMatchObject({ dispatchState: 'accepted' })
  expect(await submission(b.envelope.clientOperationId)).toBeUndefined()
  expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([a])
  expect(closeSession.mock.calls).toEqual([])
})

it('keeps a failed task-gate commit uncertain and refuses B without replaying A', async () => {
  await resumeBot()
  const a = await accept('uncertain task A')
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
  const record = store.getRecord(SESSION)!
  const open = providerOpen.mock.calls[0][0]
  await store.updateRecord(SESSION, {
    kind: 'instruction-pending',
    account: '/home/dev/.codex',
    policy: {
      version: 1,
      botId: 'test-bot',
      standing: 'a'.repeat(64),
      snapshot: 'b'.repeat(64),
      scope: agentSessionInstructionScope(record, '/home/dev/.codex'),
      nativeId: record.providerHandleChain.at(-1)!.handle.nativeId,
      operationId: 'uncertain-install-A',
      generation: open.acquisitionGeneration!,
      anchor: record.providerHandleChain.at(-1)!.linkId,
      fence: record.lease.runtimeFence,
      state: 'pending'
    }
  })
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const failing = vi
    .spyOn(journal, 'appendLifecycleBatch')
    .mockRejectedValue(new Error('write unavailable'))
  closeSession.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(10_000)
  await eventually(() => expect(closeSession.mock.calls.length).toBeGreaterThan(0))
  expect(await submission(a)).not.toMatchObject({ dispatchState: 'rejected' })
  failing.mockRestore()
  const b = await host.send(CALLER, hostTestSendParams('explicit B'))
  expect(b).toMatchObject({
    ok: true,
    value: {
      submission: { dispatchState: 'rejected', rejection: { instructionRecovery: 'pending' } }
    }
  })
  await proveOpen()
  await host.flushStreamedEvents(SESSION)
  expect(dispatch.mock.calls).toEqual([])
  expect(store.getRecord(SESSION)?.instructionPolicy).toMatchObject({
    operationId: 'uncertain-install-A',
    state: 'pending'
  })
  closeSession.mockResolvedValue(true)
})

it('cannot retry an automation task as authenticated owner text', async () => {
  await resumeBot()
  const a = await accept('automation task')
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
  await vi.advanceTimersByTimeAsync(10_000)
  await eventually(async () => expect((await submission(a))?.dispatchState).toBe('rejected'))
  const original = hostTestSendParams('automation task')
  const params = structuredAgentSessionMessageSendMutation({
    sessionId: SESSION,
    clientOperationId: original.envelope.clientOperationId,
    expectedRuntimeFence: 3,
    body: original.body,
    retryOfClientMessageId: a
  })
  expect(await host.send(CALLER, { ...params, userSend: true })).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_invalid' }
  })
  expect(await submission(original.envelope.clientOperationId)).toBeUndefined()
  await proveOpen()
  expect(dispatch.mock.calls).toEqual([])
})

it.each([false, true, 'recorded'] as const)(
  'an explicit B checks a pending writer whose death is now provable: %s',
  async (dead) => {
    await resumeBot()
    const a = await ownerTask('retained task after append uncertainty')
    await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
    const open = providerOpen.mock.calls[0][0]
    const record = store.getRecord(SESSION)!
    await store.updateRecord(SESSION, {
      kind: 'instruction-pending',
      account: '/home/dev/.codex',
      policy: {
        version: 1,
        botId: 'test-bot',
        standing: 'a'.repeat(64),
        snapshot: 'b'.repeat(64),
        scope: agentSessionInstructionScope(record, '/home/dev/.codex'),
        nativeId: record.providerHandleChain.at(-1)!.handle.nativeId,
        operationId: 'uncertain-install-A',
        generation: open.acquisitionGeneration!,
        anchor: record.providerHandleChain.at(-1)!.linkId,
        fence: record.lease.runtimeFence,
        state: 'pending'
      }
    })
    closeSession.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await eventually(async () => expect((await submission(a))?.dispatchState).toBe('rejected'))
    await eventually(() => expect(closeSession.mock.calls.length).toBeGreaterThan(0))
    const probe = vi.fn(async () =>
      dead
        ? { outcome: 'pid-absent' as const }
        : { outcome: 'indeterminate' as const, reason: 'writer cannot be verified' }
    )
    host.deps.probeOwner = probe
    if (dead === 'recorded') {
      await store.evictProvenDeadOwner({
        sessionId: SESSION,
        expectedFence: store.getRecord(SESSION)!.lease.runtimeFence,
        probe: { outcome: 'pid-absent' },
        now: 1_800_000_000_001
      })
    }
    const original = hostTestSendParams('retained task after append uncertainty')
    const b = original.envelope.clientOperationId
    const params = structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      clientOperationId: b,
      expectedRuntimeFence: dead === 'recorded' ? 4 : 3,
      body: original.body,
      retryOfClientMessageId: a
    })
    expect(await host.send(CALLER, { ...params, userSend: true })).toMatchObject({ ok: true })
    if (dead) {
      await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
      await proveOpen()
      await eventually(async () => expect((await submission(b))?.dispatchState).toBe('accepted'))
      expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
        '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
      )
    } else {
      await eventually(async () =>
        expect(await submission(b)).toMatchObject({
          dispatchState: 'rejected',
          rejection: { instructionRecovery: 'pending', neverReachedAgent: true }
        })
      )
      expect(providerOpen.mock.calls.length).toBe(1)
    }
    if (dead !== 'recorded') {
      expect(probe.mock.calls.length).toBeGreaterThan(0)
    }
    expect(await host.send(CALLER, { ...params, userSend: true })).toMatchObject({
      ok: true,
      replayed: true
    })
    await proveGeneration('generation-1')
    await host.flushStreamedEvents(SESSION)
    expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual(dead ? [b] : [])
    expect(await submission(a)).toMatchObject({ dispatchState: 'rejected' })
    closeSession.mockResolvedValue(true)
  }
)

it('enforces the recovery bound while idle warm-child close is held outside the ordered lane', async () => {
  const seed = await accept('plain warm child')
  await proveOpen()
  await eventually(async () => expect((await submission(seed))?.dispatchState).toBe('accepted'))
  enableBotHome()
  dispatch.mockClear()
  let release!: (exited: boolean) => void
  const closed = new Promise<boolean>((resolve) => {
    release = resolve
  })
  closeSession.mockImplementation(() => closed)
  try {
    const a = await ownerTask('A must not wait indefinitely for close')
    await eventually(() => expect(closeSession.mock.calls.length).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await submission(a)).toMatchObject({ dispatchState: 'pending' })
    await vi.advanceTimersByTimeAsync(1_001)
    await eventually(async () =>
      expect(await submission(a)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { instructionRecovery: 'timeout', neverReachedAgent: true }
      })
    )
    expect(acquire.mock.calls.length).toBe(1)
    expect(store.getRecord(SESSION)?.lease.claimStatus).not.toBe('released')
    const b = await ownerTask('B also has a bounded refusal while close is unproved')
    await vi.advanceTimersByTimeAsync(10_000)
    await eventually(async () => expect((await submission(b))?.dispatchState).toBe('rejected'))
    release(true)
    await host.flushStreamedEvents(SESSION)
    expect(dispatch.mock.calls).toEqual([])
    const c = await ownerTask('C may reacquire after proven close')
    await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
    await proveOpen()
    await eventually(async () => expect((await submission(c))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([c])
  } finally {
    release(true)
    closeSession.mockResolvedValue(true)
  }
})
