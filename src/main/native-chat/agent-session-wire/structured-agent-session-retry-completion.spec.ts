import type { Rig } from './structured-agent-session-retry-completion-test-support'
import type { StructuredAgentSessionRequestFailures } from './structured-agent-session-request-failures'
import {
  journalOf,
  key,
  hidden,
  flush,
  root,
  fail,
  tail,
  accounting,
  assertRetired,
  assertNoOrdinaryWork,
  withEscalation
} from './structured-agent-session-retry-completion-test-support'
import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { latestNativeChatTurnSinceRequest } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { registerRetryStopCompletion } from './structured-agent-session-retry-stop-completion.spec'

export function registerRetryCompletion(get: () => Rig): void {
  it('consumes T without Stop when H starts before its reply, retaining physical failed history and real escalation authority', async () => {
    const rig = get()
    await withEscalation(rig, async (mail, drain, complete) => {
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      expect(rig.failures).toHaveLength(0)
      const release = rig.turns.holdNextAnswer()
      try {
        await vi.advanceTimersByTimeAsync(1_999)
        expect(hidden(rig)).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(hidden(rig)).toHaveLength(1)
        rig.turns.start()
        const h = rig.turns.turnId!
        await flush(rig)
        await tail(rig, t, 'running')
        await drain()
        expect(rig.failures).toHaveLength(0)
        expect(mail()).toHaveLength(0)
        rig.turns.end('completed')
        await flush(rig)
        release()
        await vi.advanceTimersByTimeAsync(0)
        await tail(rig, t, 'success')
        await drain()
        expect(rig.failures).toHaveLength(0)
        expect(mail()).toHaveLength(0)
        expect(journalOf(rig).itemBody(key(t))).toMatchObject({ outcome: 'failure' })
        expect(journalOf(rig).itemBody(key(h))).toMatchObject({ outcome: 'success' })
        assertRetired(rig)
        await vi.advanceTimersByTimeAsync(90_000)
        expect(hidden(rig)).toHaveLength(1)
        // The dispatch stays live after H succeeds; a genuine later error must still insert Run mail.
        await root(rig)
        const u = rig.turns.turnId!
        rig.turns.end('failed', 'invalid request', 'invalidRequest')
        await flush(rig)
        await drain()
        expect(rig.failures).toMatchObject([{ id: key(u), outcome: 'failure' }])
        expect(mail()).toHaveLength(1)
        expect(JSON.stringify(mail())).toContain(key(u))
        await tail(rig, u, 'duplicate')
        await drain()
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(1)
        // A previously reported X stays accounted while another request recovers.
        await root(rig)
        await fail(rig)
        await tail(rig, u, 'other-recovery-pending')
        await vi.advanceTimersByTimeAsync(2_000)
        rig.turns.start()
        rig.turns.end('completed')
        await flush(rig)
        await vi.advanceTimersByTimeAsync(0)
        await tail(rig, u, 'other-recovery-success')
        await drain()
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(1)
        complete()
        await root(rig)
        rig.turns.end('failed', 'after dispatch completed', 'invalidRequest')
        await flush(rig)
        await drain()
        expect(rig.failures).toHaveLength(2)
        expect(mail()).toHaveLength(1)
      } finally {
        release()
      }
    })
  })

  it.each(['before-reply', 'after-reply'] as const)(
    'releases only H5 at the cap with terminal %s and ignores every older completion tail',
    async (timing) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain) => {
        const turns = [await root(rig)]
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await fail(rig)
        for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
          const release = rig.turns.holdNextAnswer()
          try {
            await vi.advanceTimersByTimeAsync(delay)
            expect(hidden(rig)).toHaveLength(index + 1)
            expect(hidden(rig).at(-1)?.params?.input).toEqual([])
            rig.turns.start()
            turns.push(rig.turns.turnId!)
            if (timing === 'after-reply') {
              await flush(rig)
              release()
              await vi.advanceTimersByTimeAsync(0)
            }
            await fail(rig)
            for (const old of turns.slice(0, -1)) {
              await tail(rig, old, `attempt-${index}`)
            }
            expect(rig.failures).toHaveLength(timing === 'after-reply' && index === 4 ? 1 : 0)
            release()
            await vi.advanceTimersByTimeAsync(0)
            await flush(rig)
            expect(rig.failures).toHaveLength(index === 4 ? 1 : 0)
          } finally {
            release()
          }
        }
        await drain()
        expect(rig.failures).toMatchObject([{ id: key(turns[5]), outcome: 'failure' }])
        expect(mail()).toHaveLength(1)
        expect(JSON.stringify(mail())).toContain(key(turns[5]))
        assertRetired(rig)
        for (const old of turns) {
          await tail(rig, old, 'after-cap')
        }
        expect(rig.failures).toHaveLength(1)
        // A real lifecycle change has authority; request attribution alone has none.
        const identity = codexTurnLifecycleIdentity(SESSION, turns[0])
        const journal = journalOf(rig)
        const body = journal.itemBody(key(turns[0]))!
        if (body.kind !== 'turn') {
          throw new Error('root missing')
        }
        await journal.appendItem(
          identity,
          { ...body, requestedAt: 99 },
          { fence: rig.conversationFence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        expect(rig.failures).toHaveLength(1)
        await journal.appendItem(
          identity,
          { ...body, state: 'running', outcome: undefined },
          { fence: rig.conversationFence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        await journal.appendItem(
          identity,
          { ...body, outcome: 'failure' },
          { fence: rig.conversationFence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        expect(rig.failures).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(90_000)
        expect(hidden(rig)).toHaveLength(5)
      })
    }
  )

  it.each([
    ['refused', 'none'],
    ['throw', 'none'],
    ['missing-id', 'none'],
    ['refused', 'running'],
    ['missing-id', 'success'],
    ['throw', 'failed']
  ] as const)(
    'settles row-free %s with actual successor=%s once and never resends uncertainty',
    async (result, successor) => {
      const rig = get()
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const answer = Promise.withResolvers<unknown>()
      rig.codex.routes['turn/start'] = () => answer.promise
      await vi.advanceTimersByTimeAsync(2_000)
      expect(hidden(rig)).toHaveLength(1)
      if (successor !== 'none') {
        rig.notify('turn/started', {
          threadId: THREAD,
          turn: { id: 'actual-H', status: 'inProgress' }
        })
        if (successor !== 'running') {
          rig.notify('turn/completed', {
            threadId: THREAD,
            turn: {
              id: 'actual-H',
              status: successor === 'success' ? 'completed' : 'failed',
              ...(successor === 'failed'
                ? { error: { message: 'H failed', codexErrorInfo: 'invalidRequest' } }
                : {})
            }
          })
        }
        await flush(rig)
      }
      if (result === 'refused') {
        answer.reject(new CodexAppServerRequestError('turn/start', -32600, 'refused', 'refused'))
      } else if (result === 'throw') {
        answer.reject(new Error('transport ended without reply'))
      } else {
        answer.resolve({})
      }
      await vi.advanceTimersByTimeAsync(0)
      await flush(rig)
      assertRetired(rig)
      const failed = successor === 'none' ? t : successor === 'failed' ? 'actual-H' : null
      expect(rig.failures.map((failure) => failure.id)).toEqual(failed ? [key(failed)] : [])
      for (let index = 0; index < 3; index++) {
        rig.host.publishWorkChanged(SESSION)
        await tail(rig, t, `settled-${index}`)
      }
      expect(rig.failures.map((failure) => failure.id)).toEqual(failed ? [key(failed)] : [])
      if (successor === 'running') {
        rig.notify('turn/completed', {
          threadId: THREAD,
          turn: {
            id: 'actual-H',
            status: 'failed',
            error: { message: 'genuine final H', codexErrorInfo: 'invalidRequest' }
          }
        })
        await flush(rig)
        expect(rig.failures.map((failure) => failure.id)).toEqual([key('actual-H')])
      }
      await vi.advanceTimersByTimeAsync(90_000)
      expect(hidden(rig)).toHaveLength(1)
      assertRetired(rig)
    }
  )

  registerRetryStopCompletion(get)

  it.each(['unproven', 'throw'] as const)(
    'releases the exact failure before an ordinary live close is %s, without treating it as disposal',
    async (result) => {
      const rig = get()
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const connection = rig.codex.connections.at(-1)!
      const close = connection.close.bind(connection)
      connection.close = async () => {
        if (result === 'throw') {
          throw new Error('transport close failed')
        }
        return false
      }
      try {
        await expect(rig.host.close(SESSION, 'user-close')).rejects.toThrow()
        expect(rig.failures).toMatchObject([{ id: key(t), outcome: 'failure' }])
        expect(connection.closed).toBe(false)
        expect(rig.host.collaboratorsForTests().conversationDelivery.loop.isDisposed()).toBe(false)
        assertRetired(rig)
        await vi.advanceTimersByTimeAsync(90_000)
        expect(hidden(rig)).toHaveLength(0)
        expect(rig.failures).toHaveLength(1)
      } finally {
        connection.close = close
      }
    }
  )

  it.each([false, true])(
    'settles unexpected live generation loss with actual H=%s before cleanup, without duplicate completion callbacks',
    async (activeHidden) => {
      const rig = get()
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      let final = t
      if (activeHidden) {
        await vi.advanceTimersByTimeAsync(2_000)
        rig.turns.start()
        final = rig.turns.turnId!
        await flush(rig)
        await vi.advanceTimersByTimeAsync(0)
      }
      rig.codex.connections
        .at(-1)!
        .handlers.onExit?.(new Error('unexpected provider death'), { expected: false })
      await vi.waitFor(() => expect(rig.failures).toHaveLength(1))
      await flush(rig)
      await vi.advanceTimersByTimeAsync(0)
      expect(rig.failures).toMatchObject([
        { id: key(final), outcome: activeHidden ? 'interruption' : 'failure' }
      ])
      assertRetired(rig)
      await tail(rig, t, 'after-death')
      expect(rig.failures).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(hidden(rig)).toHaveLength(activeHidden ? 1 : 0)
    }
  )

  it('keeps accepted-input supersession when the new input is later definitively refused', async () => {
    const rig = get()
    await withEscalation(rig, async (mail, drain, _complete, notify) => {
      const t = await root(rig)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const journal = journalOf(rig)
      const baseline = accounting(rig)['baselines'].get(SESSION)!
      const slot = baseline.deferred!
      expect(slot?.request.id).toBe(key(t))
      const retry = rig.host['providerRetry']
      const owner = retry['retries'].get(SESSION)!
      expect(slot.owner).toBe(owner)
      const timer = owner.timer
      expect(timer).toBeDefined()
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      const settle = retry['deps'].settleCompletion
      const consumed = vi.fn()
      const disposition = vi
        .spyOn(retry['deps'], 'settleCompletion')
        .mockImplementation((...args) => {
          if (args[2].owner !== owner || args[3] !== 'consume') {
            return settle(...args)
          }
          expect(retry['retries'].get(SESSION)).toBe(owner)
          expect(baseline.deferred).toBe(slot)
          settle(...args)
          expect(baseline.deferred).toBeUndefined()
          expect(baseline.marks.get(`turn:${key(t)}`)?.disposition).toBe('consumed')
          expect(retry['retries'].get(SESSION)).toBe(owner)
          consumed()
        })
      const answer = Promise.withResolvers<unknown>()
      rig.codex.routes['turn/start'] = () => answer.promise
      try {
        const fields = { body: hostTestMessage('accepted new input with its own provider refusal') }
        const envelope = rig.envelope('agentSession.send', fields)
        const params = { envelope, userSend: true as const, ...fields }
        const result = await rig.host.send({ callerKey: 'client-1' }, params)
        if (!result.ok) {
          throw new Error('fresh input was refused before admission')
        }
        const receipt = rig.host.deps.store.readCommandReceipt(
          { kind: 'global' },
          envelope.clientOperationId
        )
        expect(receipt).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
        if (receipt.verdict !== 'readable' || receipt.receipt.status !== 'accepted') {
          throw new Error('command receipt missing')
        }
        const queued =
          receipt.receipt.result.kind === 'queued-draft'
            ? receipt.receipt.result.messageId
            : undefined
        let submitted = result.value.clientMessageId
        await vi.waitFor(() => {
          const entries = queued
            ? journal.submissions().filter((entry) => entry.queuedMessageId === queued)
            : [journal.submission(submitted)]
          expect(entries).toHaveLength(1)
          expect(entries[0]).toBeDefined()
          submitted = entries[0]!.clientMessageId
          expect(
            rig.starts().filter((call) => call.params?.clientUserMessageId === submitted)
          ).toHaveLength(1)
        })
        expect(rig.starts().at(-1)?.params?.input).not.toEqual([])
        expect(await rig.host.send({ callerKey: 'client-1' }, params)).toMatchObject({
          ok: true,
          replayed: true
        })
        expect(
          rig.host.deps.store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)
        ).toEqual(receipt)
        expect(consumed).toHaveBeenCalledOnce()
        expect(clear).toHaveBeenCalledWith(timer)
        expect(owner.abort.signal.aborted).toBe(true)
        assertRetired(rig)
        await drain()
        expect(rig.failures).toHaveLength(0)
        expect(mail()).toHaveLength(0)
        const detail = 'new ordinary input declined by Codex'
        answer.reject(new CodexAppServerRequestError('turn/start', -32600, detail, detail))
        await vi.waitFor(() =>
          expect(journal.submission(submitted)?.dispatchState).toBe('rejected')
        )
        await rig.waitForInputFinalization(journal, submitted)
        await flush(rig)
        await drain()
        expect(journal.submission(submitted)?.rejection).toMatchObject({
          kind: 'providerRejected',
          detail: { text: detail, audience: 'person' },
          neverReachedAgent: true
        })
        expect(rig.failures.map(({ kind, id, outcome }) => ({ kind, id, outcome }))).toEqual([
          { kind: 'refused-send', id: agentJournalSubmissionKey(submitted), outcome: 'failure' }
        ])
        expect(mail()).toHaveLength(1)
        expect(new Set(mail().map((message) => message.id)).size).toBe(1)
        expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
          requestId: agentJournalSubmissionKey(submitted),
          failureKind: 'providerRejected'
        })
        expect(JSON.stringify(mail())).toContain(detail)
        expect(notify).toHaveBeenCalledOnce()
        await tail(rig, t, 'superseded-refusal')
        await vi.advanceTimersByTimeAsync(90_000)
        await drain()
        expect(hidden(rig)).toHaveLength(0)
        expect(
          rig.starts().filter((call) => call.params?.clientUserMessageId === submitted)
        ).toHaveLength(1)
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(1)
        expect(notify).toHaveBeenCalledOnce()
        assertRetired(rig)
      } finally {
        answer.reject(new Error('test transport cleanup'))
        disposition.mockRestore()
      }
    })
  })

  it('accounts an earlier unlinked refusal beside the same live recovery slot through the journal/accounting API contract', async () => {
    // Saved API prefix, not a claim that an adapter later produces cliMissing for unknown input.
    const prior = 'saved-unsettled-input'
    let admitted = 0
    await get().restartHost(async (saved) => {
      const fence = get().conversationFence()
      const cursor = await saved.appendSubmission({
        clientMessageId: prior,
        payloadFingerprint: prior,
        body: hostTestMessage('earlier uncertain request'),
        fence,
        handoverRecorded: true
      })
      admitted = cursor.sequence
      await saved.resolveDispatch({
        clientMessageId: prior,
        fence,
        state: 'pending',
        turnScope: { kind: 'thread' }
      })
      await saved.resolveDispatch({
        clientMessageId: prior,
        fence,
        state: 'unknown',
        recovered: true,
        reason: 'host_restarted_before_acknowledgement'
      })
    })
    const rig = get()
    await withEscalation(rig, async (mail, drain, _complete, notify) => {
      const journal = journalOf(rig)
      const earlier = journal.submission(prior)!
      expect(earlier).toMatchObject({
        dispatchState: 'unknown',
        submittedSequence: admitted,
        recovered: true
      })
      expect(earlier.handedOverAt).toBeDefined()
      expect(journal.item(agentJournalSubmissionKey(prior))).not.toBeNull()
      expect(rig.starts()).toHaveLength(0)
      expect(rig.failures).toHaveLength(0)
      const t = await root(rig)
      await rig.waitForInputFinalization(
        journal,
        journal.submissions().find((entry) => entry.clientMessageId !== prior)!.clientMessageId
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      expect(rig.failures).toHaveLength(0)
      assertNoOrdinaryWork(rig)
      const snapshot = journal.snapshot()
      expect(
        latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)?.turnItem.itemId
      ).toBe(key(t))
      expect(journal.pendingSubmissions()).toEqual([])
      expect(journal.submissions().find((entry) => entry.clientMessageId !== prior)).toMatchObject({
        dispatchState: 'accepted'
      })
      expect(
        journal.submissions().find((entry) => entry.clientMessageId !== prior)!.submittedSequence
      ).toBeGreaterThan(admitted)
      expect(journal.submission(prior)?.submittedSequence).toBe(admitted)
      const failures = accounting(rig)
      const baseline = failures['baselines'].get(SESSION)!
      const slot = baseline.deferred!
      const owner = rig.host['providerRetry']['retries'].get(SESSION)!
      const item = journal.item(key(t))
      const timer = owner.timer
      expect(timer).toBeDefined()
      const assertSlot = () => {
        expect(baseline.deferred).toBe(slot)
        expect(slot.owner).toBe(owner)
        expect(slot.request.id).toBe(key(t))
        expect(journal.item(key(t))).toBe(item)
        expect(baseline.marks.get(`turn:${key(t)}`)?.disposition).toBe('deferred')
        expect(rig.host['providerRetry']['retries'].get(SESSION)).toBe(owner)
        expect(owner.timer).toBe(timer)
        expect(owner.abort.signal.aborted).toBe(false)
      }
      assertSlot()
      const calls = vi.spyOn<StructuredAgentSessionRequestFailures, 'observe'>(failures, 'observe')
      const callback = rig.host.deps.onRequestFailure!
      const observed = vi.spyOn(rig.host.deps, 'onRequestFailure').mockImplementation((failure) => {
        assertSlot()
        expect(failure.id).toBe(agentJournalSubmissionKey(prior))
        callback(failure)
        assertSlot()
      })
      const readInOrder = journal.readInOrder.bind(journal)
      const read = vi
        .spyOn(journal, 'readInOrder')
        .mockImplementation(<T>(reader: () => T): Promise<T> =>
          readInOrder(() => {
            assertSlot()
            const result = reader()
            assertSlot()
            return result
          })
        )
      const refusal = agentSessionFailureWords(
        { kind: 'cliMissing' },
        { surface: 'rejection', agentName: 'Codex' }
      )
      try {
        const before = journal.cursor()
        const committed = await journal.resolveDispatch({
          clientMessageId: prior,
          fence: rig.conversationFence(),
          state: 'rejected',
          ...refusal
        })
        expect(committed.sequence).toBe(before.sequence + 1)
        assertSlot()
        expect(journal.submission(prior)).toMatchObject({
          dispatchState: 'rejected',
          submittedSequence: admitted,
          rejection: { kind: 'cliMissing' }
        })
        expect(journal.submission(prior)?.answeredInTurn).toBeNull()
        const observation = calls.mock.calls.filter(([, , rows]) =>
          rows?.some((row) => row.kind === 'dispatch' && row.clientMessageId === prior)
        )
        expect(observation).toHaveLength(1)
        expect(observation[0]![3]).toEqual([
          { clientMessageId: prior, submittedSequence: admitted, sequence: committed.sequence }
        ])
        expect(
          calls.mock.calls.some(([, , rows]) => rows?.some((row) => row.kind === 'submission'))
        ).toBe(false)
        expect(observed).toHaveBeenCalledOnce()
        expect(rig.failures.map(({ kind, id, outcome }) => ({ kind, id, outcome }))).toEqual([
          { kind: 'refused-send', id: agentJournalSubmissionKey(prior), outcome: 'failure' }
        ])
        await drain()
        assertSlot()
        expect(read).toHaveBeenCalledOnce()
        expect(mail()).toHaveLength(1)
        expect(new Set(mail().map((message) => message.id)).size).toBe(1)
        expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
          requestId: agentJournalSubmissionKey(prior),
          error: refusal.reason
        })
        expect(notify).toHaveBeenCalledOnce()
      } finally {
        observed.mockRestore()
        read.mockRestore()
        calls.mockRestore()
      }
      assertNoOrdinaryWork(rig)
      const release = rig.turns.holdNextAnswer()
      try {
        await vi.advanceTimersByTimeAsync(1_999)
        assertSlot()
        expect(hidden(rig)).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(hidden(rig)).toHaveLength(1)
        expect(hidden(rig)[0]?.params?.input).toEqual([])
        rig.turns.start()
        const h = rig.turns.turnId!
        rig.turns.end('completed')
        await flush(rig)
        release()
        await vi.advanceTimersByTimeAsync(0)
        await drain()
        assertRetired(rig)
        expect(journal.itemBody(key(h))).toMatchObject({ outcome: 'success' })
        expect(journal.itemBody(key(t))).toMatchObject({ outcome: 'failure' })
        await tail(rig, t, 'independent-refusal-recovered')
        await vi.advanceTimersByTimeAsync(90_000)
        await drain()
        expect(hidden(rig)).toHaveLength(1)
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(1)
        expect(notify).toHaveBeenCalledOnce()
        assertRetired(rig)
      } finally {
        release()
      }
    })
  })

  it('prunes removed completion accounting and baselines re-added history without disabling a later real lifecycle', async () => {
    const rig = get()
    const t = await root(rig)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await fail(rig)
    const journal = journalOf(rig)
    const identity = codexTurnLifecycleIdentity(SESSION, t)
    const body = journal.itemBody(key(t))!
    if (body.kind !== 'turn') {
      throw new Error('root missing')
    }
    const before = accounting(rig)['baselines'].get(SESSION)!.marks.size
    await journal.appendTombstone(identity, { fence: rig.conversationFence() })
    expect(accounting(rig)['baselines'].get(SESSION)!.marks.size).toBe(before - 1)
    assertRetired(rig)
    await journal.appendItem(identity, body, {
      fence: rig.conversationFence(),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(rig.failures).toHaveLength(0)
    await tail(rig, t, 'readded-history')
    expect(rig.failures).toHaveLength(0)
    await journal.appendItem(
      identity,
      { ...body, state: 'running', outcome: undefined },
      { fence: rig.conversationFence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(identity, body, {
      fence: rig.conversationFence(),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(rig.failures).toMatchObject([{ id: key(t), outcome: 'failure' }])
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden(rig)).toHaveLength(0)
  })

  it.each([false, true])(
    'requires producer opening proof before aliases when steer captures thread scope=%s',
    async (capturedThread) => {
      const rig = get()
      const journal = journalOf(rig)
      const dispatch = journal.resolveDispatch.bind(journal)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const observer = vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (input) => {
        const committed = await dispatch(input)
        if (capturedThread && input.state === 'pending') {
          entered.resolve()
          await release.promise
        }
        return committed
      })
      const providerStart = async () => {
        rig.notify('turn/started', {
          threadId: THREAD,
          turn: { id: 'provider-T', status: 'inProgress' }
        })
        await flush(rig)
      }
      rig.codex.routes['turn/steer'] = (params) => {
        expect(params?.expectedTurnId).toBe('provider-T')
        return { turnId: 'provider-T' }
      }
      if (!capturedThread) {
        await providerStart()
      }
      const id = await rig.permissionSend('first ordinal is a steer, not a root')
      try {
        if (capturedThread) {
          await entered.promise
          expect(journal.submission(id)?.dispatchState).toBe('pending')
          expect(
            rig.codex.connections.at(-1)?.calls.some((call) => call.method === 'turn/steer')
          ).toBe(false)
          await providerStart()
          release.resolve()
        }
        await vi.waitFor(() =>
          expect(
            rig.codex.connections.at(-1)?.calls.some((call) => call.method === 'turn/steer')
          ).toBe(true)
        )
        rig.notify('item/completed', {
          threadId: THREAD,
          turnId: 'provider-T',
          item: { type: 'userMessage', id: 'first-steer-echo', clientId: id, content: [] }
        })
        await flush(rig)
        await vi.waitFor(() => expect(journal.submission(id)?.dispatchState).toBe('accepted'))
        expect(journal.receiptFor(id)).not.toBeNull()
        const turn = journal.itemBody(key('provider-T'))
        if (turn?.kind !== 'turn' || !turn.userItemId) {
          throw new Error('provider opener missing')
        }
        expect(parseAgentJournalItemKey(turn.userItemId)?.provider).toBe('codex')
        expect(journal.canonicalItemId(turn.userItemId)).toBe(agentJournalSubmissionKey(id))
        expect(journal.item(agentJournalSubmissionKey(id))?.turnScope?.kind).toBe(
          capturedThread ? 'thread' : 'turn'
        )
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        rig.notify('turn/completed', {
          threadId: THREAD,
          turn: {
            id: 'provider-T',
            status: 'failed',
            error: { message: 'overloaded', codexErrorInfo: 'serverOverloaded' }
          }
        })
        await flush(rig)
        await vi.advanceTimersByTimeAsync(90_000)
        expect(hidden(rig)).toHaveLength(0)
        expect(rig.failures.map((failure) => failure.id)).toEqual([key('provider-T')])
      } finally {
        release.resolve()
        observer.mockRestore()
      }
    }
  )
}

export {
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
}
