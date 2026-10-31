import { expect, it, vi } from 'vitest'
import type { Rig } from './structured-agent-session-retry-completion-test-support'
import {
  root,
  fail,
  journalOf,
  accounting,
  key,
  hidden,
  assertRetired,
  withEscalation
} from './structured-agent-session-retry-completion-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'

export function registerRetryStopCompletion(get: () => Rig): void {
  it.each(['prepare', 'written'] as const)(
    'releases a precommit-refused Stop after early abort of %s with no later provider row',
    async (phase) => {
      const rig = get()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      await withEscalation(rig, async (mail, drain, _complete, notify) => {
        const t = await root(rig)
        if (phase === 'prepare') {
          await rig.pick('auto')
        }
        const preparation = Promise.withResolvers<unknown>()
        const entered = vi.fn(() => preparation.promise)
        rig.codex.routes[phase === 'prepare' ? 'config/read' : 'turn/start'] = entered
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await fail(rig)
        const baseline = accounting(rig)['baselines'].get(SESSION)!
        const owner = rig.host['providerRetry']['retries'].get(SESSION)!
        const slot = baseline.deferred!
        const timer = owner.timer
        expect(timer).toBeDefined()
        expect(slot.owner).toBe(owner)
        expect(slot.request.id).toBe(key(t))
        const clear = vi.spyOn(globalThis, 'clearTimeout')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(entered).toHaveBeenCalledOnce()
        const journal = journalOf(rig)
        const database = journal['database'].db
        database.exec(
          "CREATE TRIGGER fail_retry_stop BEFORE INSERT ON agent_session_command_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END"
        )
        const publications = vi.spyOn(rig.host['clientDelivery'], 'publishGenerationEnded')
        try {
          expect(await rig.stop()).toMatchObject({
            ok: false,
            refusal: { code: 'agent_session_operation_invalid', details: { reason: 'stopFailed' } }
          })
          await vi.advanceTimersByTimeAsync(0)
          expect(rig.failures).toMatchObject([{ id: key(t), outcome: 'failure' }])
          assertRetired(rig)
          expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
          expect(journal.itemBody(key(t))).toMatchObject({ outcome: 'failure' })
          expect(rig.failures).toHaveLength(1)
          expect(owner.abort.signal.aborted).toBe(true)
          expect(owner.timer).toBeUndefined()
          expect(clear).toHaveBeenCalledWith(timer)
          expect(baseline.marks.get(`turn:${key(t)}`)?.disposition).toBe('reported')
          expect(publications).toHaveBeenCalledWith(SESSION)
          await drain()
          expect(mail()).toHaveLength(1)
          expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
            sessionId: SESSION,
            requestId: key(t),
            turnOutcome: 'failure'
          })
          expect(notify).toHaveBeenCalledOnce()
          preparation.resolve(phase === 'prepare' ? rig.config : { turn: { id: 'unopened-H' } })
          await vi.advanceTimersByTimeAsync(90_000)
          expect(rig.failures).toHaveLength(1)
          expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
          assertRetired(rig)
          await drain()
          expect(mail()).toHaveLength(1)
          expect(notify).toHaveBeenCalledOnce()
        } finally {
          try {
            database.exec('DROP TRIGGER fail_retry_stop')
          } finally {
            preparation.resolve(rig.config)
            publications.mockRestore()
            clear.mockRestore()
          }
        }
      })
    }
  )

  it.each([
    { boundary: 'null', phase: 'prepare', fault: false },
    { boundary: 'reject', phase: 'prepare', fault: false },
    { boundary: 'require', phase: 'written', fault: false },
    { boundary: 'receipt', phase: 'prepare', fault: true },
    { boundary: 'require', phase: 'written', fault: true }
  ] as const)(
    'settles whole Stop admission at $boundary with fault=$fault',
    async ({ boundary, phase, fault }) => {
      const rig = get()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const t = await root(rig)
      if (phase === 'prepare') {
        await rig.pick('auto')
      }
      const reply = Promise.withResolvers<unknown>()
      const entered = vi.fn(() => reply.promise)
      rig.codex.routes[phase === 'prepare' ? 'config/read' : 'turn/start'] = entered
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fail(rig)
      const baseline = accounting(rig)['baselines'].get(SESSION)!
      const owner = rig.host['providerRetry']['retries'].get(SESSION)!
      const slot = baseline.deferred!
      await vi.advanceTimersByTimeAsync(2_000)
      expect(entered).toHaveBeenCalledOnce()
      const journal = journalOf(rig)
      const delivery = rig.host.collaboratorsForTests().conversationDelivery
      const originalOpen = delivery.open.bind(delivery)
      const originalRequire = rig.host.deps.store.requireWritableRecord.bind(rig.host.deps.store)
      const originalPublication = rig.host['clientDelivery'].publishGenerationEnded
      const originalCallback = rig.host.deps.onRequestFailure!
      const completionError = new Error('completion callback unavailable')
      const publicationError = new Error('row-free publication unavailable')
      const initiatingError = fault ? undefined : new Error('post-open admission unavailable')
      let armRequire = false
      const reached = vi.fn()
      const callback = vi.spyOn(rig.host.deps, 'onRequestFailure').mockImplementation((failure) => {
        originalCallback(failure)
        if (fault) {
          throw completionError
        }
      })
      let publicationAttempts = 0
      const publication = vi
        .spyOn(rig.host['clientDelivery'], 'publishGenerationEnded')
        .mockImplementation((id, options) => {
          if (id === SESSION && callback.mock.calls.length > 0) {
            publicationAttempts += 1
            if (fault && publicationAttempts === 1) {
              throw publicationError
            }
          }
          return originalPublication(id, options)
        })
      const requireRecord = vi
        .spyOn(rig.host.deps.store, 'requireWritableRecord')
        .mockImplementation((id) => {
          if (id === SESSION && armRequire) {
            armRequire = false
            reached()
            throw initiatingError
          }
          return originalRequire(id)
        })
      const open = vi.spyOn(delivery, 'open')
      const warned = vi.spyOn(rig.host.deps.logger, 'warn')
      const database = journal['database'].db
      let triggerInstalled = false
      try {
        if (boundary === 'null') {
          open.mockResolvedValueOnce(null)
          expect(await rig.stop(t)).toMatchObject({
            ok: false,
            refusal: AGENT_SESSION_NOT_ATTACHED
          })
          expect(owner.abort.signal.aborted).toBe(false)
          expect(baseline.deferred).toBe(slot)
          expect(rig.host['providerRetry']['retries'].get(SESSION)).toBe(owner)
          expect(callback).not.toHaveBeenCalled()
          expect(publication).not.toHaveBeenCalled()
        }
        if (boundary === 'receipt') {
          database.exec(
            "CREATE TRIGGER fail_retry_stop BEFORE INSERT ON agent_session_command_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END"
          )
          triggerInstalled = true
        } else {
          open.mockImplementationOnce(async (...args) => {
            expect(owner.abort.signal.aborted).toBe(true)
            if (boundary === 'null') {
              reached()
              return null
            }
            if (boundary === 'reject') {
              reached()
              throw new Error('open unavailable')
            }
            const opened = await originalOpen(...args)
            expect(opened).not.toBeNull()
            armRequire = true
            return opened
          })
        }
        const envelope = rig.envelope('agentSession.cancel', {})
        const outcome = await rig.host.cancel({ callerKey: 'client-1' }, { envelope }).then(
          (value) => ({ kind: 'returned' as const, value }),
          (error: unknown) => ({ kind: 'threw' as const, error })
        )
        if (boundary === 'require') {
          expect(outcome).toEqual({ kind: 'threw', error: initiatingError })
        } else {
          const refusal =
            boundary === 'null'
              ? AGENT_SESSION_NOT_ATTACHED
              : {
                  code:
                    boundary === 'receipt'
                      ? 'agent_session_operation_invalid'
                      : 'agent_session_journal_unreadable',
                  details: {
                    reason: boundary === 'receipt' ? 'stopFailed' : 'journalUnavailable'
                  }
                }
          expect(outcome).toMatchObject({ kind: 'returned', value: { ok: false, refusal } })
        }
        if (boundary !== 'receipt') {
          expect(reached).toHaveBeenCalledOnce()
        }
        expect(
          rig.host.deps.store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)
        ).toMatchObject({ verdict: 'absent' })
        expect(callback).toHaveBeenCalledOnce()
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({ id: key(t), outcome: 'failure' })
        )
        expect(owner.abort.signal.aborted).toBe(true)
        expect(owner.timer).toBeUndefined()
        expect(baseline.marks.get(`turn:${key(t)}`)?.disposition).toBe('reported')
        assertRetired(rig)
        expect(publicationAttempts).toBe(1)
        if (fault) {
          for (const [scope, error] of [
            ['stop-retry-completion', completionError],
            ['stop-retry-publication', publicationError]
          ] as const) {
            expect(warned).toHaveBeenCalledWith(
              expect.any(String),
              expect.objectContaining({
                scope,
                sessionId: SESSION,
                operationId: envelope.clientOperationId,
                error
              })
            )
          }
        }
        expect(journal.itemBody(key(t))).toMatchObject({ outcome: 'failure' })
        expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
        reply.resolve(phase === 'prepare' ? rig.config : { turn: { id: 'unopened-H' } })
        await vi.advanceTimersByTimeAsync(90_000)
        expect(callback).toHaveBeenCalledOnce()
        expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
        assertRetired(rig)
      } finally {
        try {
          if (triggerInstalled) {
            database.exec('DROP TRIGGER fail_retry_stop')
          }
        } finally {
          open.mockRestore()
          requireRecord.mockRestore()
          callback.mockRestore()
          publication.mockRestore()
          warned.mockRestore()
          reply.resolve(rig.config)
        }
      }
    }
  )
}
