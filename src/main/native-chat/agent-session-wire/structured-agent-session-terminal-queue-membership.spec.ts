import { settleTestSubscriberDeliveries } from './agent-session-subscriber-test-support'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createRetainedReadCounters } from './structured-agent-session-retained-read-counters.test-fixture'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { withStoppedHistory } from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { expect, it, vi } from 'vitest'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { selectStructuredAgentSessionInput } from './structured-agent-session-input-selection'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { subscribeQueuedHistory } from './structured-agent-session-subscriber-history.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'

it.each([10, 100])(
  'bounds current queue work independently of retained terminal cards H=%i',
  async (h) => {
    let clock = HOST_TEST_NOW
    const failures = vi.fn()
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      onRequestFailure: failures,
      now: () => ++clock,
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {}
      }
    })
    const counters = createRetainedReadCounters()
    const { phases, archived, count } = counters
    try {
      const original = await rig.workingSend()
      rig.host.stopDelivery() // Freeze provider/drain scheduling; all following queue triggers are real writes.
      let journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      counters.watchJournal(journal)
      const physical = journal.physicalCursor().epoch
      const fence = () => rig.store.getRecord(SESSION)!.lease.runtimeFence
      const gate = () =>
        structuredQueueSendGate(
          { store: rig.store, sessions: rig.host.collaboratorsForTests().sessions },
          SESSION
        )
      const publication = () => {
        selectStructuredAgentSessionInput(journal)
        return readQueuePublication(journal, gate())
      }
      const lane = <T>(run: () => Promise<T>) =>
        rig.host.collaboratorsForTests().serialize(SESSION, run)
      const insert = async (id: string, held = false) => {
        const body = hostTestMessage(id)
        expect(queuedMessagesPublishedBytesRefusal(journal, body, true)).toBeNull()
        const cursor = journal.cursor()
        await lane(() =>
          journal.queuedMessages.insert({
            messageId: id,
            body,
            ...(held ? { holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED } : {})
          })
        )
        expect(journal.cursor().sequence).toBeGreaterThan(cursor.sequence)
      }
      for (let i = 0; i < h; i++) {
        const id = `archive-withdrawn-${i}`
        await insert(id)
        expect(await rig.deleteQueued(id)).toMatchObject({ ok: true })
        if (i % 2 === 0) {
          await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
        }
        const sent = `archive-sent-${i}`,
          input = `archive-input-${i}`
        await insert(sent)
        const row = journal.queuedMessages.get(sent)!
        await lane(() =>
          journal.appendSubmission(
            {
              clientMessageId: input,
              body: row.body,
              payloadFingerprint: row.fingerprint,
              fence: fence(),
              handoverRecorded: true
            },
            { messageId: sent, expect: 'waiting' }
          )
        )
        await lane(() =>
          journal.resolveDispatch({
            clientMessageId: input,
            state: 'pending',
            turnScope: AGENT_JOURNAL_THREAD_SCOPE,
            fence: fence()
          })
        )
        await lane(() =>
          journal.resolveDispatch({
            clientMessageId: input,
            state: 'accepted',
            providerIdentity: { provider: 'orca', clientMessageId: `accepted-${i}` },
            fence: fence()
          })
        )
      }
      await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
      expect(journal.physicalCursor().epoch).toBe(physical)
      const raw = journal.queuedMessages.displayState()
      expect(
        [...raw.queue.cards.values()].filter(
          (card) => card.messageId.startsWith('archive-withdrawn-') && card.state === 'withdrawn'
        )
      ).toHaveLength(h)
      expect(
        [...raw.queue.cards.values()].filter(
          (card) => card.messageId.startsWith('archive-sent-') && card.state === 'dispatched'
        )
      ).toHaveLength(h)
      expect(journal.queuedMessages.list()).toEqual([])
      expect(
        journal
          .snapshot()
          .submissions.filter((send) => send.clientMessageId.startsWith('archive-input-'))
      ).toHaveLength(h)
      publication()
      let stopped: { clientMessageId: string; words: string }[] = []
      let acceptedKey = `archive-input-${h - 1}`
      const run = async (name: string, action: () => Promise<void>) => {
        counters.setPhase(name)
        count()
        await action()
        publication()
        expect(newestAcceptedSendKey(journal.epoch, journal.statusRead().submissions)).toBe(
          `${journal.epoch}:${acceptedKey}`
        )
        expect(
          carriedStoppedHistory(
            { journal },
            AGENT_JOURNAL_THREAD_SCOPE,
            journal.submission(original)!,
            hostTestMessage('next human')
          )
        ).toEqual(
          stopped.length
            ? { messages: stopped, covers: stopped.map((s) => s.clientMessageId) }
            : null
        )
        counters.setPhase('between')
      }
      for (const l of [0, 1]) {
        counters.setPhase('baseline')
        let received: AgentSessionSubscribeEvent[] | undefined
        const baseline = l ? [`baseline-${l}`] : []
        if (l) {
          await insert(baseline[0])
          await lane(() =>
            journal.queuedMessages.hold({
              messageIds: baseline,
              reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
            })
          )
        }
        const check = async (ids: string[]) => {
          await settleTestSubscriberDeliveries(rig.host.collaboratorsForTests().subscribers)
          const view = publication().queuedMessages
          expect(view.map((card) => card.messageId)).toEqual(ids)
          for (const card of view) {
            expect(card.body).toEqual(journal.queuedMessages.get(card.messageId)!.body)
          }
          if (l) {
            expect(view.find((card) => card.messageId === baseline[0])?.paused).toBe(true)
          }
          if (received) {
            const last = received.findLast(
              (event) => event.type === 'batch' && event.queuedMessages !== undefined
            )
            expect(last?.type === 'batch' ? last.queuedMessages : undefined).toEqual(view)
          }
        }
        const cycle = async (id: string, edit = false) => {
          const before = publication()
          await insert(id)
          const after = publication()
          expect(after.queuedMessages).not.toBe(before.queuedMessages)
          await check([...baseline, id])
          if (edit) {
            expect(
              await lane(() =>
                journal.queuedMessages.update({
                  messageId: id,
                  expectedBodyFingerprint: journal.queuedMessages.get(id)!.fingerprint,
                  text: 'edited current',
                  images: []
                })
              )
            ).toMatchObject({ status: 'updated' })
            expect(
              publication().queuedMessages.find((card) => card.messageId === id)?.body
            ).toEqual(hostTestMessage('edited current'))
            if (l) {
              expect(
                await lane(() =>
                  journal.queuedMessages.move({ messageId: id, beforeMessageId: baseline[0] })
                )
              ).toMatchObject({ status: 'moved' })
              await check([id, ...baseline])
            }
          }
          expect(await rig.deleteQueued(id)).toMatchObject({ ok: true })
          await check(baseline)
          expect(publication().queuePause).toBeNull()
        }
        await run(`cycles-${l}`, async () => {
          for (let i = 0; i < 10; i++) {
            await cycle(`cycle-${l}-${i}`, i === 0)
          }
        })
        const { frames, close, expectCaughtUp } = await subscribeQueuedHistory(rig.host, journal, {
          sessionId: SESSION,
          id: `retained-reader-${l}`
        })
        received = frames
        try {
          await run(`subscriber-${l}`, async () => {
            for (let i = 0; i < 10; i++) {
              await cycle(`subscriber-${l}-${i}`)
              expectCaughtUp(journal.cursor(), archived)
            }
            expect(frames.every((event) => event.type === 'batch')).toBe(true)
            expect(frames.length).toBeGreaterThanOrEqual(20)
          })
        } catch (error) {
          close()
          throw error
        }
        await run(`stop-${l}`, async () => {
          const pending = rig.send(`stop pending ${l}`)
          expect(await pending.result).toMatchObject({ ok: true })
          const settled = rig.host.waitForSendSettlement(SESSION, pending.id)
          expect(await rig.stop()).toMatchObject({ ok: true })
          const stoppedAnswer = (await settled)?.value
          if (!stoppedAnswer || !('submission' in stoppedAnswer)) {
            throw new Error('Stop lost its submission settlement')
          }
          expect(stoppedAnswer.submission.clientMessageId).toBe(pending.id)
          expect(journal.submission(pending.id)?.dispatchState).not.toBe('pending')
          stopped.push({ clientMessageId: pending.id, words: `stop pending ${l}` })
          publication()
          await insert(`after-stop-${l}`)
          publication()
          expect(await rig.deleteQueued(`after-stop-${l}`)).toMatchObject({ ok: true })
        })
        await run(`resume-${l}`, async () => {
          expect(await rig.resume()).toMatchObject({ ok: true })
          publication()
          await cycle(`after-resume-${l}`)
        })
        await run(`rewind-${l}`, async () => {
          await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
          publication()
          await cycle(`after-rewind-${l}`)
          expect(journal.physicalCursor().epoch).toBe(physical)
        })
        await run(`recovery-${l}`, async () => {
          const beforeFailures = failures.mock.calls.length
          const id = `recovery-${l}`,
            input = `recovery-input-${l}`
          await insert(id)
          const card = journal.queuedMessages.get(id)!
          await lane(() =>
            journal.appendSubmission(
              {
                clientMessageId: input,
                origin: 'client',
                body: card.body,
                payloadFingerprint: card.fingerprint,
                handoverRecorded: true,
                fence: fence()
              },
              { messageId: id, expect: 'waiting' }
            )
          )
          const primed = journal.queuedMessages.list()
          expect(primed.map((row) => row.messageId)).toContain(id)
          const revision = journal.queuedMessages.displayState().queue.revision
          await lane(() =>
            journal.resolveDispatch({
              clientMessageId: input,
              state: 'pending',
              turnScope: AGENT_JOURNAL_THREAD_SCOPE,
              fence: fence()
            })
          )
          expect(journal.queuedMessages.displayState().queue.revision).toBe(revision)
          expect(journal.queuedMessages.list()).not.toBe(primed)
          expect(journal.queuedMessages.list().map((row) => row.messageId)).not.toContain(id)
          expect(journal.queuedMessages.awaitReopenMark()).toBe(true)
          await lane(() =>
            holdUnsentSends(journal, {
              fence: fence(),
              hold: { cause: 'chatClosed' },
              unrun: (entry) => entry.clientMessageId === input
            })
          )
          expect(journal.queuedMessages.get(id)?.body).toEqual(card.body)
          const direct = `failed-start-${l}`
          await lane(() =>
            journal.appendSubmission({
              clientMessageId: direct,
              origin: 'client',
              body: hostTestMessage(direct),
              payloadFingerprint: direct,
              handoverRecorded: true,
              fence: fence()
            })
          )
          await lane(() =>
            journal.appendLifecycleBatch({
              settlementId: direct,
              mutations: [],
              fence: fence(),
              keepFailedStart: true,
              dispatches: [
                {
                  clientMessageId: direct,
                  state: 'rejected',
                  fence: fence(),
                  ...agentSessionFailureWords(
                    agentSessionFailureFact('providerStartFailed', { neverReachedAgent: true }),
                    { surface: 'rejection' }
                  )
                }
              ]
            })
          )
          expect(
            failures.mock.calls
              .slice(beforeFailures)
              .map(([edge]) => ({ id: edge.id, outcome: edge.outcome }))
          ).toEqual([{ id: `orca:${direct}`, outcome: 'failure' }])
          expect(publication().queuedMessages[0]?.messageId).toBe(direct)
          expect(journal.queuedMessages.get(direct)?.body).toEqual(hostTestMessage(direct))
          expect(await rig.deleteQueued(direct)).toMatchObject({ ok: true })
          await check(baseline)
        })
        close()
        received = undefined
        counters.setPhase('baseline')
        if (l) {
          expect(await rig.deleteQueued(baseline[0])).toMatchObject({ ok: true })
        }
      }
      counters.setPhase('cold-reopen')
      await rig.restartHostProcess()
      await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      counters.watchJournal(journal)
      publication()
      expect(journal.physicalCursor().epoch).toBe(physical)
      counters.setPhase('raw-proof')
      for (let i = 0; i < h; i++) {
        expect(journal.queuedMessages.get(`archive-withdrawn-${i}`)?.state).toBe('withdrawn')
        expect(journal.queuedMessages.get(`archive-sent-${i}`)?.state).toBe('dispatched')
        expect(journal.submission(`archive-input-${i}`)?.dispatchState).toBe('accepted')
      }
      await run('after-reopen', async () => {
        await insert('after-reopen', true)
        expect(publication().queuedMessages.map((card) => card.messageId)).toEqual(['after-reopen'])
        expect(await rig.deleteQueued('after-reopen')).toMatchObject({ ok: true })
        expect(publication().queuedMessages).toEqual([])
      })
      const afterReopenReader = await subscribeQueuedHistory(rig.host, journal, {
        sessionId: SESSION,
        id: 'after-reopen-reader'
      })
      await run('delivery', async () => {
        const before = rig.dispatch.mock.calls.length
        const next = rig.send('real delivery after reopen')
        expect(await next.result).toMatchObject({ ok: true })
        const settled = rig.host.waitForSendSettlement(SESSION, next.id)
        await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
        expect(journal.submission(next.id)?.handedOverAt).toBeDefined()
        expect(rig.dispatch.mock.calls.at(-1)?.[0].body).toEqual(
          withStoppedHistory(hostTestMessage('real delivery after reopen'), stopped)
        )
        await rig.host.settleLateDispatch({
          sessionId: SESSION,
          clientMessageId: next.id,
          providerIdentity: {
            provider: 'codex',
            threadId: HOST_TEST_THREAD,
            turnId: 'turn-real-delivery',
            ordinal: 0
          }
        })
        const acceptedAnswer = (await settled)?.value
        if (!acceptedAnswer || !('submission' in acceptedAnswer)) {
          throw new Error('Delivery lost its submission settlement')
        }
        expect(acceptedAnswer.submission.dispatchState).toBe('accepted')
        acceptedKey = next.id
        stopped = []
      })
      counters.setPhase('stopped-setup')
      const seedStopped = async (id: string) => {
        await lane(() =>
          journal.appendSubmission({
            clientMessageId: id,
            origin: 'client',
            source: { kind: 'user' },
            body: hostTestMessage(id),
            payloadFingerprint: id,
            handoverRecorded: true,
            fence: fence()
          })
        )
        await lane(() =>
          journal.resolveDispatch({
            clientMessageId: id,
            state: 'rejected',
            fence: fence(),
            ...agentSessionFailureWords(
              agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
              { surface: 'rejection' }
            )
          })
        )
      }
      for (let i = 0; i < h; i++) {
        await seedStopped(`archive-stopped-${i}`)
      }
      await lane(() => journal.replaceEpochItems('unreconcilable_prefix', fence(), []))
      expect(journal.physicalCursor().epoch).toBe(physical)
      expect(
        journal.inputOrder.stoppedHistoryInputs('probe').map((send) => send.clientMessageId)
      ).toEqual(Array.from({ length: h }, (_, i) => `archive-stopped-${i}`))
      await lane(() =>
        journal.context.clear(
          { operationId: 'retained-stopped-clear', afterFence: fence(), clearedAt: HOST_TEST_NOW },
          { write: () => {}, committed: () => {} }
        )
      )
      const floor = journal.context.floor()!
      expect(journal.submission('archive-stopped-0')!.acceptedSequence).toBeLessThan(floor.sequence)
      await seedStopped('current-stopped')
      await run('stopped-send', async () => {
        for (let i = 0; i < 3; i++) {
          const words = `ordinary after clear ${i}`
          const before = rig.dispatch.mock.calls.length
          const next = rig.send(words)
          expect(await next.result).toMatchObject({ ok: true })
          await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
          expect(rig.dispatch.mock.calls.at(-1)?.[0].body).toEqual(
            i === 0
              ? withStoppedHistory(hostTestMessage(words), [
                  { clientMessageId: 'current-stopped', words: 'current-stopped' }
                ])
              : hostTestMessage(words)
          )
          expect(journal.stoppedHistoryCarried().get(next.id) ?? []).toEqual(
            i === 0 ? ['current-stopped'] : []
          )
          await rig.host.settleLateDispatch({
            sessionId: SESSION,
            clientMessageId: next.id,
            providerIdentity: {
              provider: 'codex',
              threadId: HOST_TEST_THREAD,
              turnId: `after-clear-${i}`,
              ordinal: 0
            }
          })
          acceptedKey = next.id
        }
      })
      await rig.host.showSessionTabs([SESSION])
      const continueLimited = async (automatic: boolean) => {
        const kind = automatic ? 'auto' : 'manual'
        const key = { provider: 'orca', clientMessageId: `usage-${kind}` } as const
        const turnItemId = agentJournalItemKey(key)
        const resetsAt = clock + 100
        await lane(() =>
          journal.appendItem(
            key,
            {
              kind: 'turn',
              turnId: `usage-${kind}`,
              state: 'completed',
              outcome: 'failure',
              startedAt: clock,
              completedAt: clock
            },
            { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        )
        await lane(() =>
          journal.appendItem(
            { provider: 'orca', clientMessageId: `limit-${kind}` },
            {
              kind: 'status',
              ...agentSessionFailureWords(
                { kind: 'usageLimitReached', usageLimit: { resetsAt } },
                { surface: 'row' }
              )
            },
            { fence: fence(), turnScope: { kind: 'turn', turnItemId } }
          )
        )
        const before = rig.dispatch.mock.calls.length
        if (automatic) {
          expect(rig.host.usageLimitContinue.readState(SESSION)?.state).toBe('scheduled')
          clock = resetsAt + 15_000
          await rig.host.usageLimitContinue.tick()
        } else {
          expect(
            await rig.host.send(
              { callerKey: 'client-1' },
              structuredAgentSessionMessageSendMutation({
                sessionId: SESSION,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: fence(),
                body: hostTestMessage(NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE),
                usageLimitContinuationOfTurnItemId: turnItemId
              })
            )
          ).toMatchObject({ ok: true })
        }
        await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
        const send = rig.dispatch.mock.calls.at(-1)![0]
        expect(send.body).toEqual(hostTestMessage(NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE))
        await rig.host.settleLateDispatch({
          sessionId: SESSION,
          clientMessageId: send.clientMessageId,
          providerIdentity: {
            provider: 'codex',
            threadId: HOST_TEST_THREAD,
            turnId: `continued-${kind}`,
            ordinal: 0
          }
        })
        acceptedKey = send.clientMessageId
        expect(journal.submission(acceptedKey)?.dispatchState).toBe('accepted')
      }
      await run('continue-manual', () => continueLimited(false))
      await run('continue-auto', () => continueLimited(true))
      await run('sleep', async () => {
        const result = await rig.host.sleepWorkspace('workspace-1')
        expect(result.failures).toBeUndefined()
        expect(result.stoppedSessionIds).toContain(SESSION)
      })
      await run('eviction', async () => {
        await rig.host.close(SESSION, 'evict')
        expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
      })
      afterReopenReader.close()
      console.info('terminal-queue-membership-counts', JSON.stringify({ h, phases }))
      for (const [name, c] of Object.entries(phases)) {
        if (
          !/^(cycles|stop|resume|rewind|recovery|subscriber)-|^(after-reopen|delivery|stopped-send|continue-manual|continue-auto|sleep|eviction)$/.test(
            name
          )
        ) {
          continue
        }
        expect(c.fullRenders, name).toBe(0)
        expect(c.fullViews, name).toBe(0)
        expect(c.fullInputs, name).toBe(0)
        expect(c.fullIterations, name).toBe(0)
        // Private rewind copies retained ownership finitely; ordinary queue actions never scan it.
        if (name.startsWith('rewind-')) {
          expect(c.archived, name).toBeGreaterThanOrEqual(2 * h)
          expect(c.archived, name).toBeLessThanOrEqual(100 * h)
        } else {
          expect(c.archived, name).toBe(0)
        }
        expect(c.restores, name).toBe(0)
        expect(c.indexed, name).toBeLessThanOrEqual(200)
        expect(c.records, name).toBeLessThanOrEqual(5000)
        expect(c.nodes, name).toBeLessThanOrEqual(10000 * Math.ceil(Math.log2(2 * h + 40)))
        expect(c.points, name).toBeLessThanOrEqual(2000)
        expect(c.endpoints, name).toBeLessThanOrEqual(2000)
        expect(c.statusRecords, name).toBeLessThanOrEqual(5000)
        expect(c.statusItems, name).toBeLessThanOrEqual(5000)
        expect(c.paths, name).toBeLessThanOrEqual(2000 * Math.ceil(Math.log2(2 * h + 40)))
        expect(c.drafts, name).toBeLessThanOrEqual(2000 * Math.ceil(Math.log2(2 * h + 40)))
      }
      expect(phases['recovery-1'].statusItems).toBeGreaterThan(0)
      expect(phases['cycles-1'].statusRecords).toBeGreaterThan(0)
      expect(phases['cycles-1'].endpoints).toBeGreaterThan(0)
      expect(phases['cold-reopen'].restores).toBeGreaterThan(0)
      expect(phases['cold-reopen'].archived).toBeGreaterThanOrEqual(2 * h)
    } finally {
      counters.setPhase('cleanup')
      counters.dispose()
      await rig.dispose()
    }
  },
  60000
)
