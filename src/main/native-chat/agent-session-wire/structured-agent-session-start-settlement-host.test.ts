import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TimerPromises from 'node:timers/promises'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import * as startFlight from './structured-agent-session-start-flight'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'

const retryClock = vi.hoisted(() => ({ fake: false }))
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof TimerPromises>()
  return {
    ...actual,
    setTimeout: (...args: Parameters<typeof actual.setTimeout>) => {
      if (!retryClock.fake) {
        return actual.setTimeout(...args)
      }
      // ast-grep-ignore: test-no-real-time-wait -- routes the retry backoff onto the faked global timer
      return new Promise((resolve) => setTimeout(() => resolve(args[1]), args[0]))
    }
  }
})

let host: ReturnType<typeof hostTestState>['host']
let acquire: ReturnType<typeof hostTestState>['acquire']
let dispatch: ReturnType<typeof hostTestState>['dispatch']
const openGates = new Map<string, () => void>()
const eventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(assertion, { timeout: 10_000, interval: 0 })

beforeEach(async () => {
  retryClock.fake = false
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  ;({ host, acquire, dispatch } = hostTestState())
  await attach()
  await host.close(SESSION, 'evict')
  acquire.mockClear()
  openGates.clear()
  host.deps.adapter.open = ({ acquisitionGeneration }) =>
    new Promise((resolve) => {
      openGates.set(acquisitionGeneration!, () => resolve({ reportedOptions: {} }))
    })
})

afterEach(() => vi.useRealTimers())

async function accept(text: string, options?: Readonly<Record<string, string>>): Promise<string> {
  const body = hostTestMessage(text)
  const fields = { body, ...(options ? { options } : {}) }
  const params = { envelope: envelope('agentSession.send', fields), ...fields }
  expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
  return params.envelope.clientOperationId
}

async function submission(id: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find((row) => row.clientMessageId === id)
}

async function heldBehindStart(text: string): Promise<string> {
  const id = await accept(text)
  await eventually(() =>
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
  )
  return id
}

async function proveOpen(): Promise<void> {
  const generation = host.collaboratorsForTests().sessions.get(SESSION)?.child?.generation
  if (!generation) {
    throw new Error('expected a published child')
  }
  await eventually(() => expect(openGates.has(generation)).toBe(true))
  openGates.get(generation)!()
  openGates.delete(generation)
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

function goal() {
  const change = { kind: 'set' as const, objective: 'finish startup' }
  return host.changeThreadGoal(CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
}

async function endAttempt() {
  const session = host.collaboratorsForTests().sessions.get(SESSION)!
  const child = session.child!
  if (!child.generation) {
    throw new Error('expected a published child')
  }
  await host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: child.fence,
    acquisitionGeneration: child.generation,
    reason: 'exited while starting',
    cause: 'unexpected-exit'
  })
  await eventually(() => expect(session.child).toBeNull())
}

describe('final logical startup settlement', () => {
  it.each([false, true])(
    'honors accepted Stop between final exit evidence and settlement (message owns start: %s)',
    async (messageOwned) => {
      host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
      const operation = messageOwned ? undefined : goal()
      const id = messageOwned ? await heldBehindStart('withdraw before settlement') : undefined
      const { sessions, runtimeState, lifetime } = host.collaboratorsForTests()
      await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
      const flight = runtimeState.startFlights.get(SESSION)!
      let stopped: ReturnType<typeof stop> | undefined
      const makeLock = startFlight.structuredAgentSessionStartFlightLock
      const lockFactory = vi
        .spyOn(startFlight, 'structuredAgentSessionStartFlightLock')
        .mockImplementation((input) => {
          const lock = makeLock(input)
          return {
            ...lock,
            commit: (step) => {
              const committed = lock.commit(step)
              void committed.then(
                (value) => {
                  if (
                    value &&
                    typeof value === 'object' &&
                    'retry' in value &&
                    value.retry === false
                  ) {
                    // Queue real Stop after exit evidence, before the owner's await continuation.
                    stopped = stop()
                  }
                },
                () => undefined
              )
              return committed
            }
          }
        })
      try {
        // The current attempt already captured its lock; retry once to install the seam.
        await endAttempt()
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
        await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
        await lifetime.failStartingChild(
          SESSION,
          sessions.get(SESSION)!.child!,
          withProviderRequestTimeout(new CodexAppServerRequestError('initialize', -1, 'deadline'), {
            method: 'initialize',
            timeoutMs: 60_000
          }),
          60_000
        )
        await expect(flight.outcome).resolves.toMatchObject({ ok: false, aborted: true })
        expect(stopped).toBeDefined()
        expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
        if (operation) {
          expect(await operation).toMatchObject({ ok: false })
        }
        if (id) {
          expect(await submission(id)).toMatchObject({
            dispatchState: 'rejected',
            reason: DISPATCH_REJECTED_CANCELLED
          })
        }
        const snapshot = await host.journalSnapshot(SESSION)
        expect(
          snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
        ).toEqual([])
        expect(snapshot.items.filter((item) => item.body.kind === 'status')).toHaveLength(
          messageOwned ? 1 : 0
        )
        expect(dispatch).not.toHaveBeenCalled()
        expect(acquire).toHaveBeenCalledTimes(2)
        expect(runtimeState.startFlights.has(SESSION)).toBe(false)
      } finally {
        lockFactory.mockRestore()
      }
    }
  )

  it.each(['deadline', 'stop'] as const)(
    'ends a joining operation on its own %s without running it on a replacement child',
    async (ending) => {
      const ran = vi.fn(async () => ({ ok: true as const }))
      host.deps.adapter.changeThreadGoal = ran
      const first = await heldBehindStart('message owns the start')
      const operation = goal()
      // Ensure the operation joined this flight before ending its first child.
      await host.collaboratorsForTests().serialize(SESSION, async () => undefined)
      await endAttempt()
      if (ending === 'stop') {
        expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
      } else {
        await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_START_WAIT_MS)
      }
      expect(await operation).toMatchObject({
        ok: false,
        refusal: {
          code:
            ending === 'deadline'
              ? 'agent_session_operation_expired'
              : 'agent_session_owner_restart_failed'
        }
      })
      expect(ran).not.toHaveBeenCalled()
      if (ending === 'deadline') {
        expect(await submission(first)).toMatchObject({ dispatchState: 'pending' })
        await eventually(() =>
          expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
        )
        await proveOpen()
        await eventually(async () =>
          expect((await submission(first))?.dispatchState).toBe('accepted')
        )
      } else {
        expect(await submission(first)).toMatchObject({
          dispatchState: 'rejected',
          reason: DISPATCH_REJECTED_CANCELLED
        })
      }
      expect(ran).not.toHaveBeenCalled()
    }
  )

  it('recovers a message-owned failed final write on the next accept without transferring its failure', async () => {
    const first = await heldBehindStart('original requester')
    const later = await accept('later queued message')
    const { sessions, lifetime, conversationDelivery } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const append = journal.appendLifecycleBatch.bind(journal)
    const write = vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((input) => {
      if (input.settlementId.startsWith('start-failure:')) {
        return Promise.reject(new Error('failure write unavailable'))
      }
      return append(input)
    })
    await lifetime.failStartingChild(
      SESSION,
      sessions.get(SESSION)!.child!,
      withProviderRequestTimeout(new CodexAppServerRequestError('initialize', -1, 'deadline'), {
        method: 'initialize',
        timeoutMs: 60_000
      }),
      60_000
    )
    await eventually(() => expect(conversationDelivery.loop.isRunning(SESSION)).toBe(false))
    expect(await submission(first)).toMatchObject({ dispatchState: 'pending' })
    expect(await submission(later)).toMatchObject({ dispatchState: 'pending' })
    expect(dispatch).not.toHaveBeenCalled()
    write.mockRestore()
    const wake = await accept('new wake after journal recovery')
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    const failed = await host.journalSnapshot(SESSION)
    expect(failed.submissions.find((row) => row.clientMessageId === first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: {
        kind: 'startFailed',
        requestTimeout: { method: 'initialize', timeoutMs: 60_000 }
      }
    })
    expect(failed.submissions.find((row) => row.clientMessageId === later)).toMatchObject({
      dispatchState: 'pending',
      reason: null
    })
    expect(
      failed.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ failure: expect.objectContaining({ kind: 'startFailed' }) })
      })
    ])
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    await proveOpen()
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later, wake])
    )
    const snapshot = await host.journalSnapshot(SESSION)
    expect(
      snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
    ).toHaveLength(1)
  })

  it('preserves pinned launch inputs and failure words through direct and flight-owned starts', async () => {
    const options = { model: 'gpt-5', effort: 'high' }
    await host.deps.store.replaceSessionOptions({
      sessionId: SESSION,
      fence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence,
      options,
      now: Date.now()
    })
    const refuse = async () => {
      throw new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')
    }
    acquire.mockImplementation(refuse)
    const attached = await host.attach(
      CALLER,
      hostTestAttachParams(host.deps.store.getRecord(SESSION)!.lease.runtimeFence)
    )
    expect(attached).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'notSignedIn' } }
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    const direct = acquire.mock.calls.at(-1)![0]
    expect(direct.options).toEqual(options)
    acquire.mockClear()
    const first = await accept('same launch through a message', options)
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    const flight = acquire.mock.calls[0]![0]
    expect({
      launch: flight.launch,
      options: flight.options,
      permissionMode: flight.permissionMode,
      identity: flight.identity
    }).toEqual({
      launch: direct.launch,
      options: direct.options,
      permissionMode: direct.permissionMode,
      identity: direct.identity
    })
    expect(await submission(first)).toMatchObject(
      agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
        agentName: 'Codex',
        surface: 'rejection'
      })
    )
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  // Leave room for five starts per requester under the saved provider-handle cap.
  it.each([4, 40])(
    'bounds physical work and retires starts for %i accepted requesters',
    async (count) => {
      retryClock.fake = true
      const { sessions, runtimeState, conversationDelivery, serialize } =
        host.collaboratorsForTests()
      const retained = hostTestAttachParams(host.deps.store.getRecord(SESSION)!.lease.runtimeFence)
      expect(await host.attach(CALLER, retained)).toMatchObject({ ok: true })
      const child = sessions.get(SESSION)!.child
      expect(child).toBeTruthy()
      for (let n = 0; n < count; n++) {
        expect(await host.attach(CALLER, retained)).toMatchObject({ ok: true, replayed: true })
        expect(sessions.get(SESSION)!.child).toBe(child)
      }
      expect(acquire).toHaveBeenCalledTimes(1)
      await host.close(SESSION, 'evict')
      expect(runtimeState.currentEventSink(SESSION)).toBeUndefined()
      acquire.mockClear()
      openGates.clear()
      const other = 'unrelated-chat'
      const unrelated = hostTestAttachParams(null, {
        providerHandle: undefined,
        envelope: envelope(
          'agentSession.attach',
          {},
          { sessionId: other, expectedRuntimeFence: null }
        )
      })
      expect(await host.create(CALLER, unrelated)).toMatchObject({ ok: true })
      await serialize(other, async () => {})
      expect(conversationDelivery.loop.isRunning(other)).toBe(false)
      const otherJournal = sessions.get(other)!.journal
      const frames = Array.from({ length: count }, () => 0)
      const unsubscribe = frames.map((_, index) =>
        host.subscribeStatus({
          id: `count-${index}`,
          emit: (event) => {
            if (event.type === 'status' && event.session.sessionId === SESSION) {
              frames[index]!++
            }
          }
        })
      )
      frames.fill(0)
      const reads = vi.spyOn(otherJournal, 'submissions')
      const writes = vi.spyOn(otherJournal, 'appendLifecycleBatch')
      const probe = vi.fn<NonNullable<typeof host.deps.probeOwner>>(async () => ({
        outcome: 'pid-absent'
      }))
      host.deps.probeOwner = probe
      const baselineTimers = vi.getTimerCount()
      const active = new Set<AbortSignal>()
      const begin = runtimeState.acquireAborts.begin.bind(runtimeState.acquireAborts)
      const handles = vi
        .spyOn(runtimeState.acquireAborts, 'begin')
        .mockImplementation((...args) => {
          const handle = begin(...args)
          active.add(handle.signal)
          return {
            ...handle,
            end: () => {
              active.delete(handle.signal)
              handle.end()
            }
          }
        })
      try {
        const ids: string[] = []
        for (let n = 0; n < count; n++) {
          ids.push(await accept(`failed requester ${n}`))
        }
        const successor = [await accept('successor first'), await accept('successor second')]
        await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
        expect(acquire).toHaveBeenCalledTimes(1)
        expect(runtimeState.startFlights.get(SESSION)!.children).toHaveLength(1)
        const settlements = vi.spyOn(sessions.get(SESSION)!.journal, 'appendLifecycleBatch')
        for (let n = 0; n < count; n++) {
          await eventually(() => expect(acquire).toHaveBeenCalledTimes(n * 5 + 1))
          const flight = runtimeState.startFlights.get(SESSION)!
          for (let attempt = 0; attempt < 5; attempt++) {
            await eventually(() => expect(acquire).toHaveBeenCalledTimes(n * 5 + attempt + 1))
            await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
            await endAttempt()
            if (attempt < 4) {
              await vi.advanceTimersByTimeAsync(100 * 2 ** attempt)
            }
          }
          await expect(flight.outcome).resolves.toMatchObject({ ok: false })
          expect(flight.children).toHaveLength(5)
        }
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(5 * count + 1))
        await proveOpen()
        await eventually(() =>
          expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual(successor)
        )
        const snapshot = await host.journalSnapshot(SESSION)
        const rejected = snapshot.submissions.filter((row) => row.dispatchState === 'rejected')
        expect(rejected.map((row) => row.clientMessageId)).toEqual(ids)
        const finalWrites = settlements.mock.calls.filter(([batch]) =>
          batch.settlementId.startsWith('start-failure:')
        )
        expect(finalWrites).toHaveLength(count)
        expect(
          finalWrites.flatMap(
            ([batch]) => batch.dispatches?.map((row) => row.clientMessageId) ?? []
          )
        ).toEqual(ids)
        settlements.mockRestore()
        expect(snapshot.items.filter((item) => item.body.kind === 'status')).toHaveLength(count)
        expect(
          snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
        ).toHaveLength(count)
        expect(runtimeState.startFlights.has(SESSION)).toBe(false)
        expect(runtimeState.startupAttempts.isOpen(SESSION)).toBe(false)
        await host.close(SESSION, 'evict')
        const stopped: string[] = []
        for (let n = 0; n < count; n++) {
          stopped.push(await accept(`withdraw requester ${n}`))
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
          await endAttempt()
          await vi.advanceTimersByTimeAsync(100 * 2 ** attempt)
        }
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(5 * count + 6))
        await eventually(() => expect(sessions.get(SESSION)?.child).toBeTruthy())
        expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
        await vi.advanceTimersByTimeAsync(2000)
        await eventually(() => expect(conversationDelivery.loop.isRunning(SESSION)).toBe(false))
        expect(acquire).toHaveBeenCalledTimes(5 * count + 6)
        expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual(successor)
        const final = await host.journalSnapshot(SESSION)
        expect(final.submissions.filter((row) => stopped.includes(row.clientMessageId))).toEqual(
          stopped.map((clientMessageId) =>
            expect.objectContaining({
              clientMessageId,
              dispatchState: 'rejected',
              reason: DISPATCH_REJECTED_CANCELLED
            })
          )
        )
        expect(runtimeState.startFlights.has(SESSION)).toBe(false)
        expect(runtimeState.startupAttempts.isOpen(SESSION)).toBe(false)
        expect(runtimeState.currentEventSink(SESSION)).toBeUndefined()
        expect(active.size).toBe(0)
        expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimers)
        const place = runtimeState.deliveryOrder.reserve(SESSION)
        await place.before
        place.release()
        expect(reads).not.toHaveBeenCalled()
        expect(writes).not.toHaveBeenCalled()
        expect(probe.mock.calls.every(([record]) => record.sessionId !== other)).toBe(true)
        expect(frames[0]).toBeGreaterThan(0)
        expect(frames[0]).toBeLessThanOrEqual(20 * (5 * count + 6) + 8 * count)
        expect(frames.every((value) => value === frames[0])).toBe(true)
      } finally {
        handles.mockRestore()
        reads.mockRestore()
        writes.mockRestore()
        unsubscribe.forEach((off) => off())
      }
    },
    120_000
  )
})
