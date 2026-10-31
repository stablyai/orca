import { expect, it, vi } from 'vitest'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { Rig } from './structured-agent-session-codex-provider-retry-test-support'
import {
  clock,
  fail,
  journalOf,
  root
} from './structured-agent-session-codex-provider-retry-test-support'
import { withEscalation } from './structured-agent-session-retry-completion-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

export function registerReleasedFailureReads(get: () => Rig): void {
  it.each(['live', 'clear-close'] as const)(
    'keeps a released read lazy for exact late words and rejects other sources: %s',
    async (ending) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain, _complete, notify) => {
        await root(rig)
        clock()
        await fail(rig)
        const journal = journalOf(rig)
        const observer = rig.host['clientDelivery'].requestFailures
        const baseline = observer['baselines'].get(SESSION)!
        const snapshot = vi.spyOn(journal, 'snapshot')
        expect(rig.host['providerRetry'].retire(SESSION)).toBe(true)
        const request = rig.failures[0]!
        expect(baseline.releasedRead).toBeDefined()
        expect(snapshot).not.toHaveBeenCalled()
        await journal.appendItem(
          { provider: 'orca', clientMessageId: 'released-late-words' },
          { kind: 'status', tone: 'error', text: 'precise late released sentence' },
          { fence: rig.conversationFence(), turnScope: { kind: 'turn', turnItemId: request.id } }
        )
        await journal.appendItem(
          { provider: 'orca', clientMessageId: 'released-wrong-source' },
          { kind: 'status', tone: 'error', text: 'other producer must not supply words' },
          {
            fence: rig.conversationFence(),
            turnScope: { kind: 'turn', turnItemId: request.id },
            agentId: 'other-agent'
          }
        )
        if (ending === 'clear-close') {
          await journal.context.clear(
            { operationId: 'released-clear', afterFence: rig.conversationFence(), clearedAt: 1 },
            { write: () => {}, committed: () => {} }
          )
          expect(observer['baselines'].get(SESSION)).toBe(baseline)
          expect(baseline.releasedRead).toBeDefined()
          await rig.host.close(SESSION, 'evict')
          expect(rig.host.hasSession(SESSION)).toBe(false)
          await expect(journal.readInOrder(() => null)).rejects.toMatchObject({
            code: 'journal_closed'
          })
        }
        await drain()
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(1)
        expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
          requestId: request.id,
          error: 'precise late released sentence'
        })
        expect(mail()[0]?.body).not.toContain('other producer must not supply words')
        expect(notify).toHaveBeenCalledOnce()
        expect(await request.read()).not.toBeNull()
        expect(baseline.releasedRead).toBeUndefined()
        expect(rig.host['providerRetry']['retries'].size).toBe(0)
      })
    }
  )

  it.each([
    'forget',
    'permanent',
    'history',
    'epoch',
    'adoption',
    'replacement',
    'remove-readd',
    'same-clear'
  ] as const)('settles a real released read admitted inside COMMIT under %s', async (change) => {
    const rig = get()
    await withEscalation(rig, async (mail, drain, _complete, notify) => {
      await root(rig)
      clock()
      await fail(rig)
      const journal = journalOf(rig)
      const observer = rig.host['clientDelivery'].requestFailures
      const sessions = rig.host.collaboratorsForTests().sessions
      const session = sessions.get(SESSION)!
      const baseline = observer['baselines'].get(SESSION)!
      const replacement =
        change === 'replacement'
          ? new AgentSessionJournal({
              identity: journal['identity'],
              database: journal['database']
            })
          : undefined
      await replacement?.open()
      let admitted: Promise<AgentJournalSnapshot | null> | undefined
      let prefix: Promise<unknown> | undefined
      let entered = 0
      let settled = false
      let bodyFailed = false
      let bodyError: unknown
      const cleanupErrors: unknown[] = []
      try {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: `release-commit-${change}` },
          { kind: 'status', text: 'actual committed reader schedule' },
          { fence: rig.conversationFence(), turnScope: { kind: 'thread' } },
          {
            write: () => {},
            committed: () => {
              entered++
              expect(rig.host['providerRetry'].retire(SESSION)).toBe(true)
              expect(rig.failures).toHaveLength(1)
              if (change === 'epoch') {
                prefix = journal.replaceEpochItems('handle_forked', rig.conversationFence(), [])
              } else if (change === 'same-clear') {
                prefix = journal.context.clear(
                  {
                    operationId: 'queued-same-clear',
                    afterFence: rig.conversationFence(),
                    clearedAt: 1
                  },
                  { write: () => {}, committed: () => {} }
                )
              }
              admitted = rig.failures[0]!.read()
              void admitted.then(
                () => {
                  settled = true
                },
                () => {
                  settled = true
                }
              )
              expect(settled).toBe(false)
              expect(baseline.releasedRead).toBeDefined()
              if (change === 'adoption') {
                prefix = journal.open()
              }
              if (change === 'forget') {
                observer.forget(SESSION)
              }
              if (change === 'permanent') {
                rig.host.stopDelivery()
              }
              if (change === 'history') {
                observer.observe(SESSION, journal)
              }
              if (replacement) {
                sessions.set(SESSION, { ...session, journal: replacement })
              }
              if (change === 'remove-readd') {
                sessions.delete(SESSION)
                sessions.set(SESSION, session)
              }
              if (change !== 'epoch' && change !== 'same-clear') {
                expect(baseline.releasedRead).toBeUndefined()
              }
            }
          }
        )
        await prefix
        expect(entered).toBe(1)
        const result = await admitted
        expect(settled).toBe(true)
        expect(baseline.releasedRead).toBeUndefined()
        if (change === 'same-clear') {
          expect(result).not.toBeNull()
          await rig.host.close(SESSION, 'evict')
          expect(await rig.failures[0]!.read()).toBe(result)
        } else {
          expect(result).toBeNull()
        }
        await drain()
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(change === 'same-clear' ? 1 : 0)
        expect(notify).toHaveBeenCalledTimes(change === 'same-clear' ? 1 : 0)
        expect(rig.host['providerRetry']['retries'].size).toBe(0)
      } catch (error) {
        bodyFailed = true
        bodyError = error
      } finally {
        for (const result of await Promise.allSettled([prefix, admitted])) {
          if (result.status === 'rejected') {
            cleanupErrors.push(result.reason)
          }
        }
        if (replacement) {
          try {
            sessions.set(SESSION, session)
            await replacement.close()
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
          'released reader body/cleanup failed'
        )
      }
      if (bodyFailed) {
        throw bodyError
      }
    })
  })

  it.each(['completed', 'reassigned'] as const)(
    'keeps completed release evidence but rechecks the captured Dispatch when %s',
    async (disposition) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain, complete, notify, reassign) => {
        await root(rig)
        clock()
        await fail(rig)
        const observer = rig.host['clientDelivery'].requestFailures
        const baseline = observer['baselines'].get(SESSION)!
        rig.host['providerRetry'].retire(SESSION)
        const request = rig.failures[0]!
        const snapshot = await request.read()
        expect(snapshot).not.toBeNull()
        expect(baseline.releasedRead).toBeUndefined()
        // Completion happens during escalation's actual deferred read boundary.
        if (disposition === 'reassigned') {
          expect(reassign().status).toBe('dispatched')
        } else {
          complete()
        }
        observer.forget(SESSION)
        expect(await request.read()).toBe(snapshot)
        await drain()
        expect(rig.failures).toHaveLength(1)
        expect(mail()).toHaveLength(0)
        expect(notify).not.toHaveBeenCalled()
      })
    }
  )

  it.each(['before-seal', 'after-seal', 'forget', 'permanent'] as const)(
    'finishes or cancels the real admitted retirement prefix: %s',
    async (schedule) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain, _complete, notify) => {
        await root(rig)
        clock()
        await fail(rig)
        const journal = journalOf(rig)
        const observer = rig.host['clientDelivery'].requestFailures
        const baseline = observer['baselines'].get(SESSION)!
        rig.host['providerRetry'].retire(SESSION)
        const request = rig.failures[0]!
        const originalClose = journal.close
        const close = originalClose.bind(journal)
        const originalRead = journal.readInOrder
        const read = originalRead.bind(journal)
        const snapshot = journal.snapshot
        let reading = false
        let materializations = 0
        journal.readInOrder = <T>(body: () => T): Promise<T> =>
          read(() => {
            reading = true
            try {
              return body()
            } finally {
              reading = false
            }
          })
        const materialize = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
          if (reading && baseline.releasedRead?.retiring) {
            materializations++
          }
          return snapshot()
        })
        let admitted: Promise<AgentJournalSnapshot | null> | undefined
        let retired: Promise<void> | undefined
        let prefix: Promise<unknown> | undefined
        let entered = 0
        let finished = false
        let bodyFailed = false
        let bodyError: unknown
        const cleanupErrors: unknown[] = []
        journal.close = (completeRead) => {
          prefix = journal.appendItem(
            { provider: 'orca', clientMessageId: `final-prefix-${schedule}` },
            { kind: 'status', tone: 'error', text: 'exact final admitted prefix words' },
            { fence: rig.conversationFence(), turnScope: { kind: 'turn', turnItemId: request.id } },
            {
              write: () => {},
              committed: () => {
                entered++
                expect(rig.host.hasSession(SESSION)).toBe(false)
                expect(baseline.releasedRead?.retiring).toBe(true)
                if (schedule === 'before-seal') {
                  admitted = request.read()
                }
                retired = close(completeRead)
                admitted ??= request.read()
                void admitted.then(
                  () => {
                    finished = true
                  },
                  () => {
                    finished = true
                  }
                )
                expect(finished).toBe(false)
                expect(baseline.releasedRead).toBeDefined()
                if (schedule === 'forget') {
                  observer.forget(SESSION)
                }
                if (schedule === 'permanent') {
                  rig.host.stopDelivery()
                }
              }
            }
          )
          return prefix.then(() => retired)
        }
        try {
          await expect(rig.host.close(SESSION, 'evict')).resolves.toBeUndefined()
          expect(entered).toBe(1)
          expect(finished).toBe(true)
          const result = await admitted
          const cancelled = schedule === 'forget' || schedule === 'permanent'
          expect(materializations).toBe(cancelled ? 0 : 1)
          if (cancelled) {
            expect(result).toBeNull()
          } else {
            expect(
              result?.items.some(
                (item) =>
                  item.body.kind === 'status' &&
                  item.body.text === 'exact final admitted prefix words'
              )
            ).toBe(true)
          }
          await expect(journal.readInOrder(() => null)).rejects.toMatchObject({
            code: 'journal_closed'
          })
          expect(await request.read()).toBe(result)
          expect(baseline.releasedRead).toBeUndefined()
          expect(observer['baselines'].has(SESSION)).toBe(false)
          await drain()
          expect(rig.failures).toHaveLength(1)
          expect(mail()).toHaveLength(cancelled ? 0 : 1)
          expect(notify).toHaveBeenCalledTimes(cancelled ? 0 : 1)
          if (!cancelled) {
            expect(mail()[0]?.body).toContain('exact final admitted prefix words')
          }
        } catch (error) {
          bodyFailed = true
          bodyError = error
        } finally {
          journal.close = originalClose
          journal.readInOrder = originalRead
          materialize.mockRestore()
          for (const result of await Promise.allSettled([prefix, retired, admitted])) {
            if (result.status === 'rejected') {
              cleanupErrors.push(result.reason)
            }
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
            'retirement prefix body/cleanup failed'
          )
        }
        if (bodyFailed) {
          throw bodyError
        }
      })
    }
  )

  it('finishes untargeted released evidence when the second ordinary cleanup hook throws undefined', async () => {
    const rig = get()
    await withEscalation(rig, async (mail, drain, complete, notify) => {
      await root(rig)
      clock()
      await fail(rig)
      const journal = journalOf(rig)
      const client = rig.host['clientDelivery']
      const observer = client.requestFailures
      const baseline = observer['baselines'].get(SESSION)!
      complete()
      rig.host['providerRetry'].retire(SESSION)
      const closeSession = client.closeSession.bind(client)
      const hook = vi.spyOn(client, 'closeSession').mockImplementation((...args) => {
        closeSession(...args)
        throw undefined
      })
      try {
        await expect(rig.host.close(SESSION, 'evict')).rejects.toBeUndefined()
        expect(hook).toHaveBeenCalledOnce()
        expect(rig.host.hasSession(SESSION)).toBe(false)
        await journal.readInOrder(() => undefined)
        expect(baseline.releasedRead).toBeUndefined()
        expect(observer['baselines'].has(SESSION)).toBe(false)
        expect(await rig.failures[0]!.read()).not.toBeNull()
        await drain()
        expect(mail()).toHaveLength(0)
        expect(notify).not.toHaveBeenCalled()
      } finally {
        hook.mockRestore()
      }
    })
  })

  it.each(['active', 'none'] as const)(
    'contains a reached released materialization fault with %s Dispatch without changing ordinary close',
    async (target) => {
      const rig = get()
      await withEscalation(rig, async (mail, drain, complete, notify) => {
        await root(rig)
        clock()
        await fail(rig)
        const journal = journalOf(rig)
        const observer = rig.host['clientDelivery'].requestFailures
        const baseline = observer['baselines'].get(SESSION)!
        if (target === 'none') {
          complete()
        }
        rig.host['providerRetry'].retire(SESSION)
        const request = rig.failures[0]!
        let reading = false
        let faults = 0
        const originalRead = journal.readInOrder
        const read = originalRead.bind(journal)
        const snapshot = journal.snapshot
        const warn = vi.spyOn(console, 'warn')
        journal.readInOrder = <T>(body: () => T): Promise<T> =>
          read(() => {
            reading = true
            try {
              return body()
            } finally {
              reading = false
            }
          })
        const materialize = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
          if (reading && baseline.releasedRead?.retiring) {
            faults++
            throw undefined
          }
          return snapshot()
        })
        try {
          await expect(rig.host.close(SESSION, 'evict')).resolves.toBeUndefined()
          expect(rig.host.hasSession(SESSION)).toBe(false)
          expect(faults).toBe(1)
          expect(baseline.releasedRead).toBeUndefined()
          expect(observer['baselines'].has(SESSION)).toBe(false)
          await expect(request.read()).rejects.toBeUndefined()
          await drain()
          expect(warn).toHaveBeenCalledWith('[native-chat] released failure read failed', undefined)
          expect(mail()).toHaveLength(0)
          expect(notify).not.toHaveBeenCalled()
        } finally {
          journal.readInOrder = originalRead
          materialize.mockRestore()
          warn.mockRestore()
        }
      })
    }
  )
}
