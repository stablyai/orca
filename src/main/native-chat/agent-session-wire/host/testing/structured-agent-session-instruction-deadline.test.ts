import { structuredAgentSessionMessageSendMutation } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { expect, it, vi } from 'vitest'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionInstructionScope } from '../../../../runtime/agent-session/records/agent-session-instruction-scope'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { projectStructuredAgentSessionMessages } from '../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { codexInstructionFailure } from '../../../../codex/structured/threads/codex-bot-instruction-installation'
import {
  hostTestSendParams,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  accept,
  acquire,
  dispatch,
  eventually,
  failOpen,
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

it('publishes one canonical retry through the writer and bounded history', async () => {
  await resumeBot()
  const text = 'one retained task'
  const a = await ownerTask(text)
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(1))
  await failOpen(codexInstructionFailure('commit'))
  await eventually(async () => expect((await submission(a))?.dispatchState).toBe('rejected'))
  const retry = (target: string) => {
    const message = hostTestSendParams(text)
    return structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      clientOperationId: message.envelope.clientOperationId,
      body: message.body,
      retryOfClientMessageId: target
    })
  }
  const b = retry(a)
  expect(await host.send(CALLER, { ...b, userSend: true })).toMatchObject({ ok: true })
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
  await failOpen(codexInstructionFailure('commit'))
  const bId = b.envelope.clientOperationId
  await eventually(async () => expect((await submission(bId))?.dispatchState).toBe('rejected'))
  const recent = await host.history({ sessionId: SESSION, direction: 'tail' })
  const bRow = recent.page.items.find(({ itemId }) => itemId === agentJournalSubmissionKey(bId))!

  const c = retry(bId)
  expect(await host.send(CALLER, { ...c, userSend: true })).toMatchObject({ ok: true })
  await eventually(() => expect(providerOpen.mock.calls.length).toBe(3))
  expect(await host.send(CALLER, { ...retry(a), userSend: true })).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_invalid' }
  })
  await proveOpen()
  const cId = c.envelope.clientOperationId
  await eventually(async () =>
    expect(await submission(cId)).toMatchObject({
      dispatchState: 'accepted',
      retryOfClientMessageId: a
    })
  )

  const older = await host.history({
    sessionId: SESSION,
    direction: 'before',
    limit: 1,
    cursor: { epoch: recent.page.epoch, sequence: bRow.sequence + 1 }
  })
  expect(older.page.submissions.map(({ clientMessageId }) => clientMessageId)).toEqual([bId])
  expect(older.page.submissions[0]?.retryLineage).toMatchObject({
    clientMessageId: cId,
    dispatchState: 'accepted'
  })
  expect(
    projectStructuredAgentSessionMessages(older.page.items, [], older.page.submissions).some(
      ({ id }) => id === bRow.itemId
    )
  ).toBe(false)
  expect(dispatch.mock.calls.map(([call]) => call.clientMessageId)).toEqual([cId])
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
  const flight = host.collaboratorsForTests().runtimeState.startFlights.get(SESSION)!
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
  const write = journal.write.bind(journal)
  const failed = vi.fn()
  const failing = vi.spyOn(journal, 'write').mockImplementation((operation, prepare) => {
    if (operation.kind === 'start-failure-settle') {
      failed(operation.input)
      return Promise.reject(new Error('write unavailable'))
    }
    return write(operation, prepare)
  })
  closeSession.mockResolvedValue(false)
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await flight.outcome).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    await eventually(() => expect(closeSession.mock.calls.length).toBeGreaterThan(0))
    expect(failed).toHaveBeenCalledTimes(1)
    expect(await submission(a)).toMatchObject({ dispatchState: 'pending' })
    // Delivery claims A once more; startup refuses it before any provider open, and its closure
    // meets the same failed writer, so A stays uncertain. Waiting for it keeps B's outcome fixed.
    await eventually(() => expect(failed).toHaveBeenCalledTimes(2))
    await eventually(() =>
      expect(host.collaboratorsForTests().runtimeState.startFlights.get(SESSION)).toBeUndefined()
    )
    expect(providerOpen.mock.calls.length).toBe(1)
    expect(await submission(a)).toMatchObject({ dispatchState: 'pending' })
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
  } finally {
    failing.mockRestore()
    closeSession.mockResolvedValue(true)
  }
})

it('bypasses A after a pre-child timeout and failed typed settlement', async () => {
  await resumeBot()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  acquire.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    throw new Error('preflight ended without a child')
  })
  const a = await ownerTask('A stopped before acquiring a child')
  await entered.promise
  const { runtimeState, sessions } = host.collaboratorsForTests()
  const flight = runtimeState.startFlights.get(SESSION)!
  const session = sessions.get(SESSION)!
  expect(session.child).toBeFalsy()
  expect(providerOpen).not.toHaveBeenCalled()
  const write = session.journal.write.bind(session.journal)
  const failed = vi.fn()
  const fault = vi.spyOn(session.journal, 'write').mockImplementation((operation, prepare) => {
    if (operation.kind === 'start-failure-settle') {
      failed(operation.input)
      return Promise.reject(new Error('injected task-gate write failure'))
    }
    return write(operation, prepare)
  })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await flight.outcome).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(failed).toHaveBeenCalledTimes(1)
    expect(await session.journal.reads.submission(a)).toMatchObject({ dispatchState: 'pending' })
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    fault.mockRestore()
    release.resolve()
  }
  await runtimeState.startFlights.attemptsEnded(SESSION)
  const b = await ownerTask('B after the writer is available')
  await proveOpen()
  let deliveredB = b
  await eventually(async () => {
    deliveredB = (await session.journal.queuedMessages.get(b))?.consumedAs ?? b
    expect((await session.journal.reads.submission(deliveredB))?.dispatchState).toBe('accepted')
  })
  expect(await session.journal.reads.submission(a)).toMatchObject({ dispatchState: 'pending' })
  expect(dispatch.mock.calls.map(([call]) => call.clientMessageId)).toEqual([deliveredB])
})

it.each(['released', 'failed'] as const)(
  'settles in order after a provider-handle write is %s past the deadline',
  async (verdict) => {
    await resumeBot()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = store.updateRecord.bind(store)
    const held = vi.spyOn(store, 'updateRecord').mockImplementation(async (id, command, check) => {
      if (command.kind === 'provider-handle') {
        entered.resolve()
        await release.promise
        if (verdict === 'failed') {
          throw new Error('injected provider-handle write failure')
        }
      }
      return write(id, command, check)
    })
    try {
      const a = await ownerTask('A waits for a committed provider handle')
      await proveOpen()
      await entered.promise
      try {
        await vi.advanceTimersByTimeAsync(10_000)
        expect(dispatch).not.toHaveBeenCalled()
        expect(await submission(a)).toMatchObject({ dispatchState: 'pending' })
      } finally {
        release.resolve()
      }
      await eventually(async () =>
        expect(await submission(a)).toMatchObject({
          dispatchState: 'rejected',
          rejection: { instructionRecovery: 'timeout', neverReachedAgent: true }
        })
      )
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      held.mockRestore()
    }
  }
)

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
    closeSession.mockClear()
    const b = await ownerTask('B also has a bounded refusal while close is unproved')
    await eventually(() => expect(closeSession.mock.calls.length).toBeGreaterThan(0))
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
