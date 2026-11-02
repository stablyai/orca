import './rpc/unused-default-rpc-methods.test-fixture'
// What mail costs a chat as its backlog grows: each count is driven by the real trigger at two sizes,
// ten times apart. Work that nothing relevant asked for must be zero; work an action needs must not
// grow with what waits elsewhere.

import { describe, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  host,
  observationClock,
  openChat,
  queuedCardTexts,
  runtime,
  sendUserMessage
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** A chat with a turn running, so mail waits as cards behind it. */
async function busyChat() {
  const chat = await openChat(COORDINATOR)
  expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(COORDINATOR)
  return chat
}

function journalOf(sessionId: string): AgentSessionJournal {
  return host.collaboratorsForTests().sessions.get(sessionId)!.journal
}

/** `count` reports to the chat's Run, each admitted before the next arrives. */
async function admitReports(runId: string, count: number, from = 0) {
  for (let report = from; report < from + count; report += 1) {
    db.insertMessage({
      runId,
      from: 'term_worker',
      to: `run:${runId}`,
      subject: `report ${report}`
    })
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(report + 1), WAIT)
  }
}

describe('mail work as a chat’s backlog grows', () => {
  it.each([10, 100])(
    'admits %i reports without asking what became of the ones before',
    async (count) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      const answers = vi.spyOn(host, 'sendAnswer')
      const wakes = vi.spyOn(host, 'wakeQueuedMessages')
      // Spaced, each its own pass and watch window.
      await admitReports(runId, count / 2)
      await observationClock.observe(2_500)
      // Then a page past the lane's 50: one arrival edge drains them all.
      for (let report = count / 2; report < count; report += 1) {
        db.insertMessage({
          runId,
          from: 'term_worker',
          to: `run:${runId}`,
          subject: `page ${report}`
        })
      }
      runtime.deliverPendingMessagesForHandle(`run:${runId}`)
      await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(count), WAIT)
      await observationClock.observe(2_500)
      expect(db.getStructuredMailSends(`run:${runId}`)).toHaveLength(count)
      expect(answers).not.toHaveBeenCalled()
      expect(wakes).not.toHaveBeenCalled()
    },
    60_000
  )

  it.each([4, 40])(
    'publishes the queue once for an idle edge over %i waiting reports',
    async (count) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      await admitReports(runId, count)
      await observationClock.observe(2_500)
      const answers = vi.spyOn(host, 'sendAnswer')
      const publications = vi.fn()
      const stop = host.observeJournalPublications(COORDINATOR, publications)
      runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
      await vi.waitFor(() => expect(answers).toHaveBeenCalledTimes(count), WAIT)
      await observationClock.observe(2_500)
      stop()
      // Each waiting report is asked about once; their chat republishes once, not once per report.
      expect(answers).toHaveBeenCalledTimes(count)
      expect(publications).toHaveBeenCalledTimes(1)
    },
    30_000
  )

  it.each([4, 40])(
    'redrives nothing while the agent streams text over %i waiting reports',
    async (count) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      await admitReports(runId, count)
      const journal = journalOf(COORDINATOR)
      const fence = host.deps.store.getConversation(COORDINATOR)!.currentFence
      const write = (text: string) =>
        journal.appendItem(
          { provider: 'orca', clientMessageId: 'streamed-reply' },
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
          { fence, turnScope: { kind: 'thread' } }
        )
      await write('x')
      await observationClock.observe(2_500)
      const answers = vi.spyOn(host, 'sendAnswer')
      const statuses = vi.spyOn(runtime, 'onStructuredSessionStatusForMail')
      const before = journal.cursor().sequence
      for (let revision = 2; revision <= 6; revision += 1) {
        await write('x'.repeat(revision))
        await observationClock.observe(400)
      }
      expect(journal.cursor().sequence - before).toBe(5)
      expect(JSON.stringify((await host.journalSnapshot(COORDINATOR)).items)).toContain('xxxxxx')
      // The status feed still reports the working chat; mail hears nothing new in it.
      expect(statuses).toHaveBeenCalled()
      expect(answers).not.toHaveBeenCalled()
    },
    30_000
  )

  it.each([4, 40])(
    'checks one Run without touching %i other Runs’ waiting mail',
    async (count) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      for (let other = 0; other < count; other += 1) {
        const run = db.createRun({
          objective: `other-${other}`,
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorOrcaSessionId: testOrcaSessionId(COORDINATOR)
        })
        db.insertMessage({ runId: run.id, from: 'term_worker', to: `run:${run.id}`, subject: 'x' })
        runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
        await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(other + 1), WAIT)
      }
      await observationClock.observe(2_500)
      const answers = vi.spyOn(host, 'sendAnswer')
      const withdraw = vi.spyOn(host, 'queuedMessageDelete')
      expect(
        await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
      ).toMatchObject({ count: 0 })
      await observationClock.observe(2_500)
      expect(answers).not.toHaveBeenCalled()
      expect(withdraw).not.toHaveBeenCalled()
      expect(await queuedCardTexts()).toHaveLength(count)
      // A check that takes its own Run's waiting report deletes that card alone.
      db.insertMessage({ runId, from: 'term_worker', to: `run:${runId}`, subject: 'mine' })
      runtime.deliverPendingMessagesForHandle(`run:${runId}`)
      await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(count + 1), WAIT)
      expect(
        await call('orchestration.check', { run: runId }, { sessionId: COORDINATOR })
      ).toMatchObject({ count: 1 })
      await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(count), WAIT)
      expect(answers).toHaveBeenCalledTimes(1)
      // Startup still settles every mailbox holding mail, once each: the others and this Run's own.
      const scheduler = runtime['mailPointerRepointScheduler']
      const schedules = vi.spyOn(scheduler, 'schedule').mockImplementation(() => {})
      runtime['scheduleRestoredMessageRepoints']()
      expect(schedules).toHaveBeenCalledTimes(count + 1)
    },
    30_000
  )

  it.each([4, 40])(
    'decides custody without listing %i other visible tabs',
    async (count) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      for (let other = 0; other < count; other += 1) {
        const sessionId = `00000000-0000-4000-8000-${String(other).padStart(12, '0')}`
        await host.deps.store.reserveOwner({
          sessionId,
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree'
          },
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/tmp/unused-scaling' },
          expectedFence: null,
          spawnToken: `unused-${other}`,
          claimKeyId: 'key-1',
          handoffOperationId: null,
          probe: { outcome: 'reservation-unused' },
          operation: {
            callerKey: 'scaling',
            operationId: operationId(),
            fingerprint: `f-${other}`
          },
          now: Date.now()
        })
        await host.deps.store.setSessionTabVisibility(sessionId, true)
      }
      await admitReports(runId, 1)
      await observationClock.observe(2_500)
      const listed = vi.spyOn(host.deps.store, 'getVisibleSessionTabIndex')
      const row = db.getStructuredMailSends(`run:${runId}`)[0]!
      const from = journalOf(COORDINATOR).queuedMessages.get(row.operation_id)!.body.from!
      for (let check = 0; check < 10; check += 1) {
        expect(runtime.structuredChatMailOwed(COORDINATOR, from, true)).toBe('owed')
      }
      expect(listed).not.toHaveBeenCalled()
      // The chat's tab closing still ends what it is owed.
      await host.deps.store.setSessionTabVisibility(COORDINATOR, false)
      expect(runtime.structuredChatMailOwed(COORDINATOR, from, true)).not.toBe('owed')
    },
    30_000
  )

  it.each([40, 400])(
    'admits four reports without reading %i earlier messages',
    async (history) => {
      await busyChat()
      const { runId } = await coordinatorRunAndTask()
      const journal = journalOf(COORDINATOR)
      const fence = host.deps.store.getConversation(COORDINATOR)!.currentFence
      for (let input = 0; input < history; input += 1) {
        const id = `earlier-${input}`
        await journal.appendSubmission({
          clientMessageId: id,
          origin: 'client',
          payloadFingerprint: id,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'earlier' }] },
          fence,
          handoverRecorded: true
        })
        await journal.resolveDispatch({
          clientMessageId: id,
          fence,
          state: 'accepted',
          providerIdentity: null
        })
      }
      const histories = vi.spyOn(journal, 'submissions')
      await admitReports(runId, 4)
      // At most the delivery loop's own restart-hold read: none per report, none by id.
      expect(histories.mock.calls.length).toBeLessThanOrEqual(1)
      expect(await queuedCardTexts()).toHaveLength(4)
    },
    30_000
  )
})
