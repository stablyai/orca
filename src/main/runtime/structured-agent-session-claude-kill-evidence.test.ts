import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudePipedFixture, SESSION } from './structured-claude-piped-test-support'
import { CLAUDE_READER_DRAIN_AFTER_EXIT_MS } from '../claude/claude-stream-json-connection'
import { SUPERVISED_GRACEFUL_EXIT_MS } from '../claude/claude-child-exit-proof-ladder'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { nativeSwitchPhysicalFixture } from './structured-native-switch-physical.test-fixture'
import { agentSessionSwitchDeadline } from '../../shared/agent-session-switch-execution'
import { attachParamsForRecord } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'

const os = vi.hoisted(() => ({
  capture: vi.fn(),
  terminate: vi.fn(async () => 'unverifiable' as const)
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: os.capture }))
vi.mock('../pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: os.terminate
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

let fixture: Awaited<ReturnType<typeof claudePipedFixture>>
beforeEach(async () => {
  os.capture.mockImplementation(async (pid: number) => ({
    rootPgid: pid,
    capturedAtMs: 1,
    root: { pid, startedAt: 'Mon Jan 1 00:00:00 2026' },
    descendants: [{ pid: pid + 1, ppid: pid, pgid: pid + 1, startedAt: 'Mon Jan 1 00:00:00 2026' }]
  }))
  fixture = await claudePipedFixture()
})
afterEach(async () => {
  vi.useRealTimers()
  await fixture.dispose()
  vi.restoreAllMocks()
})
async function attach() {
  expect(await fixture.host.attach(fixture.caller, fixture.params())).toMatchObject({ ok: true })
  await fixture.ready()
}
async function forceTime() {
  await vi.advanceTimersByTimeAsync(SUPERVISED_GRACEFUL_EXIT_MS + 8000)
}
function killEvidence() {
  expect(fixture.record().lease).toMatchObject({
    claimStatus: 'released',
    ownerProcess: null,
    reservedSpawnToken: null,
    handoffStage: null,
    deathEvidence: { kind: 'kill-delivered' }
  })
  expect(fixture.adapter.hasOwnedAcquisition!(SESSION)).toBe(false)
  expect(
    fixture.host.deps.store.listOperationRows().some((row) => row.outcome.status === 'pending')
  ).toBe(false)
}

it('preserves actual TRUE writer-close through published close, join, and a healthy successor', async () => {
  await attach()
  const old = fixture.host.collaboratorsForTests().sessions.get(SESSION)!.child!
  const events = vi.spyOn(fixture.host, 'handleAdapterEvent')
  fixture.permitKill.add(0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const closing = fixture.host.close(SESSION, 'evict')
  await forceTime()
  await closing
  await fixture.drain()
  killEvidence()
  const database = JournalHostDatabase.open(fixture.directory)
  try {
    const reopened = AgentSessionRecordStore.open({
      journalDatabase: database,
      hostId: 'local',
      legacySessionTabIds: []
    })
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no root event' }),
      now: Date.now()
    })
    expect(reopened.isSessionUnreadable(SESSION)).toBe(false)
    expect(reopened.getRecord(SESSION)?.lease.deathEvidence).toEqual(
      fixture.record().lease.deathEvidence
    )
  } finally {
    await database.close()
  }
  expect(fixture.connections[0]!.exitVerdict).toMatchObject({ root: 'live', killDelivered: true })
  expect(await fixture.connections[0]!.close()).toBe(true)
  expect(events.mock.calls.filter(([event]) => event.type === 'ended')).toHaveLength(1)
  expect(events.mock.calls).toContainEqual([
    expect.objectContaining({ type: 'ended', deathEvidenceKind: 'kill-delivered' })
  ])
  const kills = fixture.signal.mock.calls.length
  expect(await fixture.connections[0]!.close()).toBe(true)
  expect(fixture.signal.mock.calls).toHaveLength(kills)
  vi.useRealTimers()
  await fixture.healthy()
  const replacement = fixture.record().lease
  await fixture.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    cause: 'requested-close',
    reason: 'late old receipt',
    fence: old.fence,
    acquisitionGeneration: old.generation!,
    deathEvidenceKind: 'kill-delivered'
  })
  expect(fixture.record().lease).toEqual(replacement)
})

it('joins actual idle Claude root exit before the ordinary switch destination writer', async () => {
  await attach()
  const switching = await nativeSwitchPhysicalFixture(
    fixture.host,
    SESSION,
    fixture.directory,
    'claude'
  )
  try {
    fixture.permitKill.add(0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const operation = switching.run()
    await forceTime()
    await fixture.drain()
    killEvidence()
    expect(switching.spawn).not.toHaveBeenCalled()
    expect(fixture.connections[0]!.exitVerdict.root).toBe('live')
    const kills = fixture.signal.mock.calls.length
    fixture.observedExit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(await operation).toMatchObject({ status: 'completed' })
    expect(switching.spawn).toHaveBeenCalledOnce()
    expect(fixture.signal.mock.calls).toHaveLength(kills)
    expect(fixture.prompts).toEqual([])
  } finally {
    switching.dispose()
  }
})

it('retains every unresolved ordinary generation across eviction and only joins its exact root', async () => {
  await attach()
  fixture.permitKill.add(0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const close = fixture.host.close(SESSION, 'evict')
  await forceTime()
  await close
  expect(fixture.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
  vi.useRealTimers()
  await fixture.healthy()
  fixture.permitKill.add(1)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const closeNext = fixture.host.close(SESSION, 'evict')
  await forceTime()
  await closeNext
  const switching = await nativeSwitchPhysicalFixture(
    fixture.host,
    SESSION,
    fixture.directory,
    'claude'
  )
  try {
    const operation = switching.run()
    await vi.advanceTimersByTimeAsync(0)
    await fixture.drain()
    expect(switching.spawn).not.toHaveBeenCalled()
    const kills = fixture.signal.mock.calls.length
    fixture.observedExit(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(switching.spawn).not.toHaveBeenCalled()
    fixture.observedExit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(await operation).toMatchObject({ status: 'completed' })
    expect(switching.spawn).toHaveBeenCalledOnce()
    expect(fixture.signal.mock.calls).toHaveLength(kills)
    expect(fixture.prompts).toHaveLength(1)
  } finally {
    switching.dispose()
  }
})

it('joins an unpublished failed ensure that enters while an older physical source is pending', async () => {
  await attach()
  fixture.permitKill.add(0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const closing = fixture.host.close(SESSION, 'evict')
  await forceTime()
  await closing
  const switching = await nativeSwitchPhysicalFixture(
    fixture.host,
    SESSION,
    fixture.directory,
    'claude'
  )
  const identity = Promise.withResolvers<void>()
  try {
    const operation = switching.run().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    await fixture.drain()
    expect(switching.spawn).not.toHaveBeenCalled()
    const admitted = fixture.host.deps.store.admittedSendCount(SESSION)
    const command = fixture.host.switchGeneration(SESSION)
    expect(await fixture.host.attach(fixture.caller, fixture.params())).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'sessionExists' } }
    })
    expect(fixture.connections).toHaveLength(1)
    const record = fixture.record()
    const params = attachParamsForRecord(record, {
      clientOperationId: fixture.params().envelope.clientOperationId,
      expectedRuntimeFence: record.lease.runtimeFence
    })
    fixture.heldIdentity.set(9100100, identity.promise)
    fixture.permitKill.add(1)
    // agentSession.ensure delegates to this ordinary serialized attach owner.
    const ensuring = fixture.host.attach(fixture.caller, params).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fixture.connections).toHaveLength(2))
    fixture.children[1]!.stdin.emit('error', new Error('ordinary ensure startup transport failed'))
    await forceTime()
    identity.resolve()
    await forceTime()
    expect(await ensuring).toMatchObject({ ok: false })
    await fixture.drain()
    killEvidence()
    expect(fixture.connections[1]!.exitVerdict).toMatchObject({
      root: 'live',
      killDelivered: true
    })
    expect(fixture.host.deps.store.admittedSendCount(SESSION)).toBe(admitted)
    expect(fixture.host.switchGeneration(SESSION)).toBe(command)
    expect(fixture.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeFalsy()
    const kills = fixture.signal.mock.calls.length
    fixture.observedExit(0)
    await vi.advanceTimersByTimeAsync(0)
    await fixture.drain()
    expect(switching.spawn).not.toHaveBeenCalled()
    fixture.observedExit(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await operation).toMatchObject({ status: 'completed' })
    expect(switching.spawn).toHaveBeenCalledOnce()
    expect(fixture.signal.mock.calls).toHaveLength(kills)
    expect(fixture.prompts).toEqual([])
  } finally {
    identity.resolve()
    switching.dispose()
  }
})

it.each(['deadline', 'new-send'] as const)(
  'ends an unproven switch on %s without blocking the ordinary next send or replaying on late exit',
  async (end) => {
    await attach()
    fixture.permitKill.add(0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = fixture.host.close(SESSION, 'evict')
    await forceTime()
    await closing
    const switching = await nativeSwitchPhysicalFixture(
      fixture.host,
      SESSION,
      fixture.directory,
      'claude'
    )
    try {
      const operation = switching
        .run(end === 'deadline' ? 100 : 120_000)
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      await fixture.drain()
      expect(switching.spawn).not.toHaveBeenCalled()
      if (end === 'deadline') {
        await vi.advanceTimersByTimeAsync(101)
        expect(await operation).toMatchObject({
          refusal: { code: 'agent_session_operation_expired' }
        })
        expect((await fixture.host.revealSession(SESSION)).readable).toBe(true)
      }
      vi.useRealTimers()
      await fixture.healthy('New user work is never held behind source exit.')
      if (end === 'new-send') {
        expect(await operation).toMatchObject({
          refusal: { details: { reason: 'messagesUnsettled' } }
        })
      }
      const successor = fixture.record().lease
      fixture.observedExit(0)
      await fixture.drain()
      expect(switching.spawn).not.toHaveBeenCalled()
      expect(fixture.record().lease).toEqual(successor)
      fixture.observedExit(1)
      await fixture.drain()
      expect(await switching.run()).toMatchObject({ status: 'completed' })
      expect(switching.spawn).toHaveBeenCalledOnce()
      expect(fixture.prompts).toHaveLength(1)
    } finally {
      switching.dispose()
    }
  }
)

it('settles a real failed acquisition with exact kill evidence and rejects dispatch before a healthy wake', async () => {
  await attach()
  fixture.observedExit(0)
  await fixture.host.close(SESSION, 'evict')
  const identity = Promise.withResolvers<void>()
  fixture.heldIdentity.set(9100100, identity.promise)
  fixture.permitKill.add(1)
  const pending = await fixture.send('This start fails before open.')
  expect(pending.ok).toBe(true)
  await vi.waitFor(() => expect(fixture.connections).toHaveLength(2))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fixture.children[1]!.stdin.emit('error', new Error('ordinary startup transport failed'))
  await forceTime()
  expect(fixture.delivered.has(1)).toBe(true)
  const signals = fixture.signal.mock.calls.length
  let closed: boolean | undefined
  void fixture.connections[1]!.close().then((value) => {
    closed = value
  })
  await vi.advanceTimersByTimeAsync(CLAUDE_READER_DRAIN_AFTER_EXIT_MS)
  expect(closed).toBe(true)
  expect(fixture.signal.mock.calls).toHaveLength(signals)
  identity.resolve()
  await forceTime()
  await fixture.drain()
  killEvidence()
  const journal = await fixture.host.journalSnapshot(SESSION)
  if (!pending.ok) {
    throw new Error('send refused')
  }
  expect(
    journal.submissions.find((row) => row.clientMessageId === pending.value.clientMessageId)
      ?.dispatchState
  ).toBe('rejected')
  expect(
    JSON.stringify(fixture.logs.warn.mock.calls, (_key, value) =>
      value instanceof Error ? { message: value.message, cause: value.cause } : value
    )
  ).toContain('ordinary startup transport failed')
  vi.useRealTimers()
  await fixture.healthy()
})

it('retains a non-root late-refusal receipt while its ended event waits behind host serialization', async () => {
  fixture.omitInit.add(0)
  await attach()
  const old = fixture.host.collaboratorsForTests().sessions.get(SESSION)!.child!
  const savedKinds: string[] = []
  const unsubscribe = fixture.host.deps.store.onDeathEvidence(() => {
    savedKinds.push(fixture.record().lease.deathEvidence!.kind)
  })
  const entered = Promise.withResolvers<void>()
  const join = Promise.withResolvers<void>()
  fixture.permitKill.add(0)
  const receipt = fixture.host.collaboratorsForTests().serialize(SESSION, async () => {
    entered.resolve()
    await join.promise
    return fixture.host.deps.adapter.closeSession!(SESSION).catch((error) => error)
  })
  await entered.promise
  const events = vi.spyOn(fixture.host, 'handleAdapterEvent')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fixture.emit(0, {
    type: 'system',
    subtype: 'init',
    session_id: 'foreign-session',
    uuid: 'late-foreign-init'
  })
  await forceTime()
  join.resolve()
  expect(events.mock.calls).toContainEqual([
    expect.objectContaining({ type: 'ended', deathEvidenceKind: 'kill-delivered' })
  ])
  const joined = await receipt
  expect(joined).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  expect(joined.deathEvidenceKind).toBe('kill-delivered')
  expect(joined.cause).toBeInstanceOf(Error)
  await fixture.drain()
  killEvidence()
  expect(fixture.record().lease.deathEvidence?.ownerFence).toBe(old.fence)
  expect(savedKinds).toEqual(['kill-delivered'])
  unsubscribe()
  expect(fixture.delivered.size).toBe(1)
  vi.useRealTimers()
  await fixture.healthy()
})

it.each(['identity', 'spawn-return'] as const)(
  'preserves pending-cancel proof when ownership waits at %s',
  async (boundary) => {
    await attach()
    fixture.observedExit(0)
    await fixture.host.close(SESSION, 'evict')
    const finish = Promise.withResolvers<void>()
    if (boundary === 'identity') {
      fixture.heldIdentity.set(9100100, finish.promise)
    } else {
      fixture.heldSpawn.set(1, finish.promise)
    }
    fixture.permitKill.add(1)
    const pending = await fixture.send('Cancel this pending acquisition.')
    await vi.waitFor(() => expect(fixture.connections).toHaveLength(2))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cancel = fixture.host.deps.adapter.releaseAcquisition!({ sessionId: SESSION }).catch(
      (error) => error
    )
    await forceTime()
    finish.resolve()
    await forceTime()
    const report = await cancel
    expect(report).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect(report.deathEvidenceKind).toBe('kill-delivered')
    await fixture.drain()
    killEvidence()
    const deadline = agentSessionSwitchDeadline()
    try {
      let proved = false
      const stopping = fixture.host.stopForSwitch(SESSION, fixture.caller, deadline).then(() => {
        proved = true
      })
      await vi.advanceTimersByTimeAsync(0)
      await fixture.drain()
      expect(proved).toBe(false)
      fixture.observedExit(1)
      await vi.advanceTimersByTimeAsync(0)
      await stopping
      expect(proved).toBe(true)
    } finally {
      deadline.dispose()
    }
    if (!pending.ok) {
      throw new Error('send refused')
    }
    expect(
      (await fixture.host.journalSnapshot(SESSION)).submissions.find(
        (row) => row.clientMessageId === pending.value.clientMessageId
      )?.dispatchState
    ).toBe('rejected')
    vi.useRealTimers()
    await fixture.healthy()
  }
)

it.each(['prove-owner', 'journal-attach'] as const)(
  'preserves proof after a recorded owner fails at %s',
  async (boundary) => {
    const fault = new Error(`fixture ${boundary} failure`)
    if (boundary === 'prove-owner') {
      vi.spyOn(fixture.host.deps.store, 'proveOwner').mockRejectedValueOnce(fault)
    } else {
      vi.spyOn(
        fixture.host.collaboratorsForTests().conversationDelivery,
        'open'
      ).mockRejectedValueOnce(fault)
    }
    const events = vi.spyOn(fixture.host, 'handleAdapterEvent')
    fixture.permitKill.add(0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = fixture.host.attach(fixture.caller, fixture.params()).catch((error) => error)
    await vi.waitFor(() => expect(fixture.connections).toHaveLength(1))
    await forceTime()
    expect(await pending).not.toMatchObject({ ok: true })
    await fixture.drain()
    killEvidence()
    expect(events.mock.calls).toContainEqual([
      expect.objectContaining({ type: 'ended', deathEvidenceKind: 'kill-delivered' })
    ])
    vi.useRealTimers()
    await fixture.healthy()
  }
)

it('keeps undelivered close retryable until an actual root event, without inventing kill proof', async () => {
  await attach()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const closing = fixture.host.close(SESSION, 'evict').catch((error) => error)
  await forceTime()
  expect(await closing).toBeInstanceOf(Error)
  expect(fixture.record().lease.claimStatus).toBe('live')
  expect(fixture.record().lease.deathEvidence).toBeNull()
  expect(fixture.connections[0]!.exitVerdict).toMatchObject({ root: 'live' })
  const retried = fixture.connections[0]!.close()
  await forceTime()
  expect(await retried).toBe(false)
  fixture.observedExit(0)
  await forceTime()
  await fixture.drain()
  expect(fixture.record().lease).toMatchObject({
    claimStatus: 'released',
    deathEvidence: { kind: 'exit-observed' }
  })
  expect(fixture.delivered.size).toBe(0)
  vi.useRealTimers()
  expect(await fixture.adapter.closeSession!(SESSION)).toBe(true)
  const deadline = agentSessionSwitchDeadline()
  try {
    expect(await fixture.host.stopForSwitch(SESSION, fixture.caller, deadline)).toBeTypeOf(
      'function'
    )
  } finally {
    deadline.dispose()
  }
  await fixture.healthy()
})

it('keeps an actual processless failure and an absent-session close distinct from delivery', async () => {
  fixture.nextProcessless()
  const failed = await fixture.host
    .attach(fixture.caller, fixture.params())
    .catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(Error)
  expect(fixture.connections[0]!.exitVerdict).toMatchObject({ processless: true })
  expect(fixture.record().lease).toMatchObject({
    claimStatus: 'released',
    deathEvidence: { kind: 'pid-absent' }
  })
  expect(fixture.delivered.size).toBe(0)
  expect(await fixture.adapter.closeSession!('never-spawned')).toBe(true)
  expect(await fixture.adapter.closeSession!(SESSION)).toBe(true)
  await fixture.healthy()
})

it('settles pre-adapter startup failure without holding a later explicit switch', async () => {
  await attach()
  fixture.observedExit(0)
  await fixture.host.close(SESSION, 'evict')
  const acquire = vi.spyOn(fixture.host.deps.adapter, 'acquire')
  const track = vi
    .spyOn(fixture.host.collaboratorsForTests().runtimeState.startupAttempts, 'track')
    .mockImplementationOnce(() => {
      throw new Error('fixture startup registration failed before adapter entry')
    })
  const record = fixture.record()
  const params = attachParamsForRecord(record, {
    clientOperationId: fixture.params().envelope.clientOperationId,
    expectedRuntimeFence: record.lease.runtimeFence
  })
  expect(await fixture.host.attach(fixture.caller, params)).toMatchObject({ ok: false })
  expect(track).toHaveBeenCalledOnce()
  expect(acquire).not.toHaveBeenCalled()
  expect(fixture.children).toHaveLength(1)
  const switching = await nativeSwitchPhysicalFixture(
    fixture.host,
    SESSION,
    fixture.directory,
    'claude'
  )
  try {
    expect(await switching.run()).toMatchObject({ status: 'completed' })
    expect(switching.spawn).toHaveBeenCalledOnce()
    expect(fixture.delivered.size).toBe(0)
  } finally {
    switching.dispose()
  }
})

it('preserves known delivery when the published lifecycle callback fails', async () => {
  await attach()
  const fault = new Error('fixture lifecycle callback failure')
  vi.spyOn(fixture.host, 'handleAdapterEvent').mockImplementationOnce(() => {
    throw fault
  })
  fixture.permitKill.add(0)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const closing = fixture.host.close(SESSION, 'evict')
  await forceTime()
  await closing
  await fixture.drain()
  killEvidence()
  expect(
    JSON.stringify(fixture.logs.warn.mock.calls, (_key, value) =>
      value instanceof Error ? { message: value.message, cause: value.cause } : value
    )
  ).toContain(fault.message)
  vi.useRealTimers()
  await fixture.healthy()
})

it('joins indexed non-root cleanup despite cursor failure until acknowledgment', async () => {
  fixture.omitInit.add(0)
  await attach()
  fixture.permitKill.add(0)
  vi.spyOn(fixture.host.deps.store, 'transitionHandoff').mockRejectedValueOnce(
    new Error('fixture cursor persistence failed')
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const entered = Promise.withResolvers<void>()
  const acknowledge = Promise.withResolvers<void>()
  const held = fixture.host.collaboratorsForTests().serialize(SESSION, async () => {
    entered.resolve()
    await acknowledge.promise
  })
  await entered.promise
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fixture.emit(0, {
    type: 'system',
    subtype: 'init',
    session_id: 'foreign-session',
    uuid: 'refused-init'
  })
  await vi.waitFor(() => expect(fixture.connections[0]!.closed).toBe(true))
  const joined = fixture.host.deps.adapter.releaseAcquisition!({ sessionId: SESSION }).catch(
    (error) => error
  )
  await forceTime()
  const receipt = await joined
  acknowledge.resolve()
  await held
  expect(receipt).toMatchObject({
    deathEvidenceKind: 'kill-delivered',
    message: 'claude provider session expected'
  })
  expect(receipt).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  await fixture.drain()
  killEvidence()
  expect(await fixture.adapter.releaseAcquisition!({ sessionId: SESSION })).toBe(true)
  expect(fixture.delivered.size).toBe(1)
  vi.useRealTimers()
  await fixture.healthy()
})
