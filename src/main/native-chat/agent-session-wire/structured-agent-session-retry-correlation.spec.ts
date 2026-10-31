import { expect, it, vi } from 'vitest'
import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import {
  journalOf,
  key,
  hidden,
  flush,
  root,
  fail,
  tail,
  assertRetired,
  withEscalation,
  accounting,
  assertNoOrdinaryWork
} from './structured-agent-session-retry-completion.spec'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { publishCodexTurnLifecycle } from '../../codex/codex-structured-journal-translation-turns'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'

type Rig = ReturnType<typeof codexInputFinalizationFixture>
async function started(rig: Rig, id: string) {
  rig.notify('turn/started', { threadId: THREAD, turn: { id, status: 'inProgress' } })
  await flush(rig)
}
async function ended(rig: Rig, id: string, result: 'success' | 'typed' | 'invalid') {
  rig.notify('turn/completed', {
    threadId: THREAD,
    turn: {
      id,
      status: result === 'success' ? 'completed' : 'failed',
      ...(result === 'success'
        ? {}
        : {
            error: {
              message: result === 'typed' ? 'overloaded' : 'Bad request',
              codexErrorInfo: result === 'typed' ? 'serverOverloaded' : 'badRequest'
            }
          })
    }
  })
  await flush(rig)
}
async function goalCreated(rig: Rig, h: string) {
  // Controlled protocol input, not a recorded goal execution.
  rig.notify('rawResponseItem/completed', {
    threadId: THREAD,
    turnId: h,
    item: {
      type: 'function_call',
      name: 'create_goal',
      call_id: 'create-requested-goal',
      arguments: JSON.stringify({ objective: 'complete the requested goal' })
    }
  })
  rig.notify('thread/goal/updated', {
    threadId: THREAD,
    turnId: h,
    goal: {
      threadId: THREAD,
      objective: 'complete the requested goal',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1_792_823_727,
      updatedAt: 1_792_823_727
    }
  })
  await flush(rig)
}
async function quietAfter(rig: Rig, ids: string[], writes: number) {
  assertRetired(rig)
  const callbacks = rig.failures.length
  for (const id of ids) {
    await tail(rig, id, 'settled-correlation')
  }
  for (let index = 0; index < 3; index++) {
    rig.host.publishWorkChanged(SESSION)
  }
  await vi.advanceTimersByTimeAsync(90_000)
  expect(rig.failures).toHaveLength(callbacks)
  expect(hidden(rig)).toHaveLength(writes)
  assertRetired(rig)
}

export function registerRetryCorrelation(get: () => Rig): void {
  it('settles exact independent G failure after H creates the requested goal and succeeds before reply H', async () => {
    const rig = get()
    await withEscalation(rig, async (mail, drain) => {
      const t = await root(rig, 'Create and pursue a new goal: complete the requested goal')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const release = rig.turns.holdNextAnswer()
      try {
        await vi.advanceTimersByTimeAsync(1_999)
        expect(hidden(rig)).toHaveLength(0)
        expect(rig.failures).toHaveLength(0)
        expect(mail()).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(hidden(rig)).toHaveLength(1)
        expect(hidden(rig)[0]?.params?.input).toEqual([])
        rig.turns.start()
        const h = rig.turns.turnId!
        await flush(rig)
        await goalCreated(rig, h)
        rig.turns.end('completed')
        await flush(rig)
        await started(rig, 'independent-G')
        await ended(rig, 'independent-G', 'invalid')
        expect(rig.failures).toHaveLength(0)
        release()
        await vi.advanceTimersByTimeAsync(0)
        await flush(rig)
        await drain()
        expect(rig.failures.map((failure) => failure.id)).toEqual([key('independent-G')])
        expect(mail()).toHaveLength(1)
        expect(JSON.stringify(mail())).toContain(key('independent-G'))
        expect(JSON.stringify(mail())).not.toContain(key(t))
        expect(JSON.stringify(mail())).not.toContain(key(h))
        expect(journalOf(rig).itemBody(key(t))).toMatchObject({ outcome: 'failure' })
        expect(journalOf(rig).itemBody(key(h))).toMatchObject({ outcome: 'success' })
        expect(journalOf(rig).itemBody(key('independent-G'))).toMatchObject({ outcome: 'failure' })
        expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
          status: 'idle',
          turnOutcome: 'failure'
        })
        await quietAfter(rig, [t, h, 'independent-G'], 1)
        await drain()
        expect(mail()).toHaveLength(1)
      } finally {
        release()
      }
    })
  })

  it.each(['success', 'running-final', 'running-death'] as const)(
    'delegates newer G %s at reply H to its exact legitimate wake',
    async (result) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain) => {
        const t = await root(rig)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await fail(rig)
        const release = rig.turns.holdNextAnswer()
        try {
          await vi.advanceTimersByTimeAsync(2_000)
          rig.turns.start()
          const h = rig.turns.turnId!
          rig.turns.end('completed')
          await flush(rig)
          await started(rig, 'newer-G')
          if (result === 'success') {
            await ended(rig, 'newer-G', 'success')
          }
          release()
          await vi.advanceTimersByTimeAsync(0)
          await flush(rig)
          assertRetired(rig)
          expect(rig.failures).toHaveLength(0)
          if (result === 'running-final') {
            await ended(rig, 'newer-G', 'invalid')
          }
          if (result === 'running-death') {
            rig.codex.connections
              .at(-1)!
              .handlers.onExit?.(new Error('G provider died'), { expected: false })
            await vi.waitFor(() => expect(rig.failures).toHaveLength(1))
            await flush(rig)
          }
          await drain()
          expect(rig.failures.map((failure) => failure.id)).toEqual(
            result === 'success' ? [] : [key('newer-G')]
          )
          expect(mail()).toHaveLength(result === 'success' ? 0 : 1)
          await quietAfter(rig, [t, h, 'newer-G'], 1)
        } finally {
          release()
        }
      })
    }
  )

  it.each(['H', 'G'] as const)(
    'joins returned %s itself when G opened before H and its older first end arrives after typed H',
    async (returned) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain, _complete, notify) => {
        const t = await root(rig)
        const journal = journalOf(rig)
        await rig.waitForInputFinalization(journal, journal.submissions()[0]!.clientMessageId)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await fail(rig)
        const reply = Promise.withResolvers<unknown>()
        rig.codex.routes['turn/start'] = () => reply.promise
        try {
          await vi.advanceTimersByTimeAsync(2_000)
          await started(rig, 'older-G')
          await started(rig, 'current-H')
          await ended(rig, 'current-H', 'typed')
          const baseline = accounting(rig)['baselines'].get(SESSION)!
          const slot = baseline.deferred!
          const owner = rig.host['providerRetry']['retries'].get(SESSION)!
          const assertH = () => {
            expect(baseline.deferred).toBe(slot)
            expect(slot?.owner).toBe(owner)
            expect(slot?.request.id).toBe(key('current-H'))
            expect(baseline.marks.get(`turn:${key('current-H')}`)?.disposition).toBe('deferred')
            expect(rig.host['providerRetry']['retries'].get(SESSION)).toBe(owner)
          }
          assertH()
          expect(baseline.marks.get(`turn:${key(t)}`)?.disposition).toBe('consumed')
          await ended(rig, 'older-G', 'invalid')
          assertH()
          rig.notify('turn/completed', {
            threadId: THREAD,
            turn: { id: 'current-H', status: 'failed' }
          })
          await flush(rig)
          await tail(rig, 'older-G', 'must-not-erase-H-category-before-reply')
          await drain()
          assertH()
          assertNoOrdinaryWork(rig)
          expect(rig.failures.map((failure) => failure.id)).toEqual([key('older-G')])
          expect(mail()).toHaveLength(1)
          expect(new Set(mail().map((message) => message.id)).size).toBe(1)
          expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
            requestId: key('older-G'),
            turnOutcome: 'failure'
          })
          expect(notify).toHaveBeenCalledOnce()
          reply.resolve({
            turn: { id: returned === 'H' ? 'current-H' : 'older-G', status: 'inProgress' }
          })
          await vi.advanceTimersByTimeAsync(0)
          await flush(rig)
          await tail(rig, 'older-G', 'must-not-erase-H-category')
          if (returned === 'H') {
            assertH()
            expect(structuredAgentSessionProviderRetryPending(journal)).toBe(true)
            rig.codex.routes['turn/start'] = rig.turns.routes['turn/start']
            await vi.advanceTimersByTimeAsync(3_999)
            expect(hidden(rig)).toHaveLength(1)
            await vi.advanceTimersByTimeAsync(1)
            expect(hidden(rig)).toHaveLength(2)
            rig.turns.start()
            rig.turns.end('completed')
            await flush(rig)
            await vi.advanceTimersByTimeAsync(0)
            expect(rig.failures.map((failure) => failure.id)).toEqual([key('older-G')])
          } else {
            expect(rig.failures.map((failure) => failure.id)).toEqual([
              key('older-G'),
              key('current-H')
            ])
          }
          await drain()
          const count = returned === 'H' ? 1 : 2
          expect(mail()).toHaveLength(count)
          expect(new Set(mail().map((message) => message.id)).size).toBe(count)
          expect(mail().map((message) => JSON.parse(message.payload ?? '{}').requestId)).toEqual(
            returned === 'H' ? [key('older-G')] : [key('older-G'), key('current-H')]
          )
          expect(notify).toHaveBeenCalledTimes(count)
          await quietAfter(rig, [t, 'older-G', 'current-H'], returned === 'H' ? 2 : 1)
          await drain()
          expect(mail()).toHaveLength(count)
          expect(notify).toHaveBeenCalledTimes(count)
        } finally {
          reply.resolve({})
        }
      })
    }
  )

  it('releases displaced independent final edges once across several actual roots, without claiming altered goal reachability', async () => {
    const rig = get()
    const t = await root(rig)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await fail(rig)
    const release = rig.turns.holdNextAnswer()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      rig.turns.start()
      const h = rig.turns.turnId!
      rig.turns.end('failed', 'Bad request', 'badRequest')
      await flush(rig)
      for (const [id, result] of [
        ['G1', 'typed'],
        ['G2', 'success'],
        ['G3', 'invalid']
      ] as const) {
        await started(rig, id)
        await ended(rig, id, result)
      }
      expect(rig.failures.map((failure) => failure.id)).toEqual([key(h), key('G1')])
      release()
      await vi.advanceTimersByTimeAsync(0)
      await flush(rig)
      expect(rig.failures.map((failure) => failure.id)).toEqual([key(h), key('G1'), key('G3')])
      await quietAfter(rig, [t, h, 'G1', 'G2', 'G3'], 1)
    } finally {
      release()
    }
  })

  it.each(['success', 'typed', 'invalid'] as const)(
    'retains reply-first H %s, then gives genuinely later G ordinary finality',
    async (result) => {
      const rig = get()
      await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      await vi.advanceTimersByTimeAsync(2_000)
      rig.turns.start()
      const h = rig.turns.turnId!
      await flush(rig)
      await vi.advanceTimersByTimeAsync(0)
      await ended(rig, h, result)
      if (result === 'invalid') {
        expect(rig.failures.map((failure) => failure.id)).toEqual([key(h)])
      }
      await started(rig, 'later-G')
      await ended(rig, 'later-G', 'invalid')
      expect(rig.failures.map((failure) => failure.id)).toEqual(
        result === 'success' ? [key('later-G')] : [key(h), key('later-G')]
      )
      await quietAfter(rig, [h, 'later-G'], 1)
    }
  )

  it.each([
    ['before-reply', 'success'],
    ['after-reply', 'success'],
    ['before-reply', 'invalid'],
    ['after-reply', 'invalid']
  ] as const)(
    'settles current matched H %s / %s without another notification wake',
    async (timing, result) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain) => {
        const t = await root(rig)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await fail(rig)
        const release = rig.turns.holdNextAnswer()
        try {
          await vi.advanceTimersByTimeAsync(2_000)
          rig.turns.start()
          const h = rig.turns.turnId!
          await flush(rig)
          if (timing === 'after-reply') {
            release()
            await vi.advanceTimersByTimeAsync(0)
          }
          if (result === 'success') {
            rig.turns.end('completed')
          } else {
            rig.turns.end('failed', 'Bad request', 'badRequest')
          }
          await flush(rig)
          release()
          await vi.advanceTimersByTimeAsync(0)
          await flush(rig)
          await drain()
          expect(rig.failures.map((failure) => failure.id)).toEqual(
            result === 'success' ? [] : [key(h)]
          )
          expect(mail()).toHaveLength(result === 'success' ? 0 : 1)
          if (result === 'invalid') {
            expect(JSON.stringify(mail())).toContain(key(h))
          }
          await quietAfter(rig, [t, h], 1)
        } finally {
          release()
        }
      })
    }
  )

  it('keeps current H authority when attribution recreates an absent historical lifecycle-shaped row', async () => {
    const rig = get()
    await root(rig)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await fail(rig)
    const release = rig.turns.holdNextAnswer()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      rig.turns.start()
      const h = rig.turns.turnId!
      await fail(rig)
      const sink = rig.host.collaboratorsForTests().runtimeState.currentEventSink(SESSION)!.sink
      // Exercise the real attribution producer, with no live start for this absent historical row.
      expect(
        publishCodexTurnLifecycle({
          sink,
          primaryThreadId: THREAD,
          sessionId: SESSION,
          threadId: THREAD,
          turnId: 'historical-attribution',
          state: 'completed',
          outcome: 'success',
          attributionOnly: true,
          startedAt: 1,
          completedAt: 2,
          requestedAt: 1
        })
      ).toEqual({ accepted: true })
      await flush(rig)
      expect(journalOf(rig).itemBody(key('historical-attribution'))).toMatchObject({
        state: 'completed',
        outcome: 'success'
      })
      release()
      await vi.advanceTimersByTimeAsync(0)
      await flush(rig)
      expect(rig.host['providerRetry']['retries'].get(SESSION)?.currentResult).toMatchObject({
        turnId: h,
        category: 'overloaded'
      })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(hidden(rig)).toHaveLength(2)
      rig.turns.start()
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(0)
      await quietAfter(rig, [h, 'historical-attribution'], 2)
      expect(rig.failures).toHaveLength(0)
    } finally {
      release()
    }
  })

  it('retires reply-first running H at a genuine later G and accounts both actual final errors once', async () => {
    const rig = get()
    await root(rig)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await fail(rig)
    await vi.advanceTimersByTimeAsync(2_000)
    rig.turns.start()
    const h = rig.turns.turnId!
    await flush(rig)
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.host['providerRetry']['retries'].get(SESSION)?.phase).toBe('running')
    await started(rig, 'later-running-G')
    assertRetired(rig)
    await ended(rig, h, 'invalid')
    await ended(rig, 'later-running-G', 'invalid')
    expect(rig.failures.map((failure) => failure.id)).toEqual([key(h), key('later-running-G')])
    await quietAfter(rig, [h, 'later-running-G'], 1)
  })

  it.each(['replay', 'failure'] as const)(
    'joins the actual refused-notification %s owner across an empty sink barrier',
    async (result) => {
      const rig = get()
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const release = rig.turns.holdNextAnswer()
      const journal = journalOf(rig)
      const deferred = rig.host.collaboratorsForTests().runtimeState.currentEventSink(SESSION)!
      try {
        await vi.advanceTimersByTimeAsync(2_000)
        deferred.unbind()
        for (let index = 0; index < 1_024; index++) {
          expect(
            deferred.sink.tryAppendItem?.(
              { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'occupy' },
              { kind: 'status', text: `occupied-${index}` },
              { lifecycle: true, turnScope: { kind: 'thread' } }
            )
          ).toEqual({ accepted: true })
        }
        rig.turns.start()
        const h = rig.turns.turnId!
        rig.turns.end('failed', 'overloaded', 'serverOverloaded')
        deferred.bind({
          journal,
          fence: rig.conversationFence(),
          publish: () => rig.host['subscribers'].publish(SESSION, journal)
        })
        await deferred.drained()
        expect(journal.itemBody(key(h))).toBeNull()
        release()
        await vi.advanceTimersByTimeAsync(0)
        await flush(rig)
        expect(rig.host['providerRetry']['retries'].get(SESSION)?.phase).toBe('starting')
        expect(rig.failures).toHaveLength(0)
        if (result === 'failure') {
          deferred.close()
        }
        await vi.advanceTimersByTimeAsync(25)
        await flush(rig)
        await vi.advanceTimersByTimeAsync(0)
        if (result === 'failure') {
          await vi.waitFor(() =>
            expect(rig.failures.map((failure) => failure.id)).toEqual([key(t)])
          )
          assertRetired(rig)
          expect(journal.itemBody(key(h))).toBeNull()
          await quietAfter(rig, [t], 1)
          return
        }
        expect(journal.itemBody(key(h))).toMatchObject({ outcome: 'failure' })
        expect(structuredAgentSessionProviderRetryPending(journal)).toBe(true)
        await vi.advanceTimersByTimeAsync(4_000)
        expect(hidden(rig)).toHaveLength(2)
        rig.turns.start()
        rig.turns.end('completed')
        await flush(rig)
        await vi.advanceTimersByTimeAsync(0)
        await quietAfter(rig, [h], 2)
        expect(rig.failures).toHaveLength(0)
      } finally {
        release()
        deferred.bind({
          journal,
          fence: rig.conversationFence(),
          publish: () => rig.host['subscribers'].publish(SESSION, journal)
        })
      }
    }
  )
}
