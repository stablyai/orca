import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  CALLER,
  journalOf,
  hidden,
  clock,
  flush,
  fail,
  root,
  startHidden
} from './structured-agent-session-codex-provider-retry-test-support'
import type { Rig } from './structured-agent-session-codex-provider-retry-test-support'

export function registerCodexRetryAdmission(get: () => Rig): void {
  it.each([false, true])(
    'retains ordinary Failed through the full written-U-before-Stop race, real rewind and reload with context boundary=%s',
    async (context) => {
      const rig = get()
      if (context) {
        const fields = { command: 'clear' as const }
        expect(
          await rig.host.conversationCommand(CALLER, {
            envelope: rig.envelope('agentSession.conversationCommand', fields),
            ...fields
          })
        ).toMatchObject({ ok: true })
      }
      await root(rig)
      const t = rig.turns.turnId!
      const journal = journalOf(rig)
      const key = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, t))
      const originalEpoch = journal.epoch
      const answer = Promise.withResolvers<unknown>()
      const closing = Promise.withResolvers<void>()
      const finishClose = Promise.withResolvers<void>()
      const connection = rig.codex.connections.at(-1)!
      const close = connection.close.bind(connection)
      rig.codex.routes['turn/steer'] = () => {
        throw new CodexAppServerRequestError(
          'turn/steer',
          -32600,
          'no active turn to steer',
          'no active turn to steer'
        )
      }
      rig.codex.routes['turn/start'] = () => answer.promise
      const u = await rig.permissionSend('written before Stop, echo held')
      await vi.waitFor(() =>
        expect(rig.starts().some((call) => call.params?.clientUserMessageId === u)).toBe(true)
      )
      const admitted = journal.submission(u)!.acceptedSequence!
      expect(journal.submission(u)?.handedOverAt).toBeDefined()
      expect(journal.submission(u)?.dispatchState).toBe('pending')
      rig.codex.routes['turn/interrupt'] = () => {
        rig.notify('turn/completed', {
          threadId: THREAD,
          turn: {
            id: t,
            status: 'failed',
            error: { message: 'ordinary provider refusal', codexErrorInfo: 'invalidRequest' }
          }
        })
        return {}
      }
      connection.close = async () => {
        closing.resolve()
        await finishClose.promise
        return close()
      }
      const stop = rig.stop()
      try {
        await closing.promise
        const mark = journal.queuedMessages.userStopInForce()!
        expect(mark.event.turnId).toBe(t)
        expect(admitted).toBeLessThan(mark.sequence)
        expect(journal.itemBody(key)).toMatchObject({ outcome: 'failure' })
        rig.notify('turn/started', {
          threadId: THREAD,
          turn: { id: 'delayed-U', status: 'inProgress' }
        })
        rig.notify('item/completed', {
          threadId: THREAD,
          turnId: 'delayed-U',
          item: { type: 'userMessage', id: 'delayed-u-echo', clientId: u, content: [] }
        })
        rig.notify('turn/completed', {
          threadId: THREAD,
          turn: { id: 'delayed-U', status: 'completed' }
        })
        answer.resolve({ turn: { id: 'delayed-U', status: 'inProgress' } })
        await flush(rig)
        await vi.waitFor(() => expect(journal.submission(u)?.dispatchState).toBe('accepted'))
        expect(journal.queuedMessages.userStopInForce()?.sequence).toBe(mark.sequence)
        expect(journal.stopNamesCancelledTurn(t, mark.sequence)).toBe(false)
        finishClose.resolve()
        expect(await stop).toMatchObject({ ok: true })
        let reverted = false
        rig.codex.routes['thread/read'] = () => ({
          thread: { id: THREAD, status: { type: 'idle' } }
        })
        rig.codex.routes['thread/turns/list'] = () => ({
          data: reverted ? [{ id: t }] : [{ id: 'delayed-U' }, { id: t }],
          nextCursor: null
        })
        rig.codex.routes['thread/revert'] = () => {
          reverted = true
          return { thread: { id: THREAD } }
        }
        const fields = { itemId: agentJournalSubmissionKey(u), expectedEpoch: journal.epoch }
        expect(
          await rig.host.rewind(CALLER, {
            envelope: rig.envelope('agentSession.rewind', fields),
            ...fields
          })
        ).toMatchObject({ ok: true })
        expect(reverted).toBe(true)
        expect(journal.epoch === originalEpoch).toBe(context)
        expect(journal.itemBody(key)).toMatchObject({ state: 'completed', outcome: 'failure' })
        expect(journal.queuedMessages.userStopInForce()?.event.turnId).toBe(t)
        const restarted = await rig.restartHost()
        const reopened = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
        expect(reopened.itemBody(key)).toMatchObject({ outcome: 'failure' })
        clock()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(hidden(rig)).toHaveLength(0)
      } finally {
        answer.resolve({ turn: { id: 'delayed-U' } })
        finishClose.resolve()
        await stop
      }
    }
  )

  it.each([false, true])(
    'carries an eligible unwritten retry withdrawal through actual replacement/reload with hidden terminal=%s and no extra submission',
    async (hiddenTerminal) => {
      const rig = get()
      await root(rig)
      let turnId = rig.turns.turnId!
      clock()
      await fail(rig)
      if (hiddenTerminal) {
        await startHidden(rig, 2_000, 1)
        turnId = rig.turns.turnId!
        await fail(rig)
      }
      const journal = journalOf(rig)
      expect(journal.submissions()).toHaveLength(1)
      expect(await rig.stop()).toMatchObject({ ok: true })
      const key = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
      expect(journal.itemBody(key)).toMatchObject({ outcome: 'cancellation' })
      const kept = journal.snapshot().items.map((item) => {
        const identity = parseAgentJournalItemKey(item.itemId)
        if (!identity) {
          throw new Error('missing retained identity')
        }
        return {
          identity,
          body: item.body,
          ownerFence: rig.conversationFence(),
          observedAt: item.observedAt,
          turnScope: item.turnScope ?? { kind: 'thread' as const }
        }
      })
      await journal.replaceEpochItems('handle_forked', rig.conversationFence(), kept)
      expect(journal.itemBody(key)).toMatchObject({ outcome: 'cancellation' })
      expect(journal.queuedMessages.userStopInForce()?.event).not.toHaveProperty('turnId')
      const restarted = await rig.restartHost()
      const reopened = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
      expect(reopened.itemBody(key)).toMatchObject({ outcome: 'cancellation' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(hiddenTerminal ? 1 : 0)
      const fresh = await rig.permissionSend(
        'fresh input wakes ordinary delivery after materialization'
      )
      await rig.began(fresh)
      rig.turns.end('completed')
      await restarted.flushStreamedEvents(SESSION)
      expect(reopened.itemBody(key)).toMatchObject({ outcome: 'cancellation' })
      expect(restarted.readStatusSummary(SESSION)).toMatchObject({
        status: 'idle',
        turnOutcome: 'success'
      })
    }
  )

  it('accepts a real held-batch mailbox report and receipt before the automatic start reply, then delivers once on a genuine wake', async () => {
    const rig = get()
    await root(rig)
    clock()
    await fail(rig)
    const release = rig.turns.holdNextAnswer()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(hidden(rig)).toHaveLength(1)
    const db = new OrchestrationDb(':memory:')
    setStructuredAgentSessionHost(rig.host)
    const run = db.createRun({
      objective: 'report supersedes backoff',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const mailbox = `run:${run.id}`
    const old = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'held batch'
    })
    const outstanding = db.getOrCreateMailboxDelivery({
      runId: run.id,
      mailboxHandle: mailbox,
      consumerGeneration: run.consumer_generation
    })!.delivery
    const report = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'new report'
    })
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (handle) =>
        handle === mailbox ? { sessionId: SESSION, dispatchId: null } : null,
      getCliCommand: () => 'orca',
      senderName: () => 'Worker',
      host: createStructuredMailboxPointerHost()
    })
    try {
      expect(outstanding.id).toBeTruthy()
      expect(delivery.deliverForHandle(mailbox)).toBe(true)
      const journal = journalOf(rig)
      await vi.waitFor(() => expect(journal.submissions()).toHaveLength(2))
      const operation = db.getStructuredPointerOperation(mailbox)!
      expect(
        rig.host.deps.store.readCommandReceipt({ kind: 'global' }, operation.operation_id)
      ).toMatchObject({
        verdict: 'readable',
        receipt: { status: 'accepted', result: { kind: 'journal-row' } }
      })
      expect(journal.submission(operation.operation_id)).toBeDefined()
      delivery.onJournalActivity(SESSION)
      await vi.advanceTimersByTimeAsync(0)
      expect(journal.submissions()).toHaveLength(2)
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
      const accepted = journal.submissions().at(-1)!
      expect(db.getMessageById(report.id)?.delivered_at).toBeNull()
      release()
      await vi.advanceTimersByTimeAsync(0)
      // A positive open/end settles the already-written continuation, waking ordinary delivery.
      if (
        !rig.starts().some((call) => call.params?.clientUserMessageId === accepted.clientMessageId)
      ) {
        rig.turns.start()
        rig.turns.end('completed')
        await flush(rig)
      }
      await rig.began(accepted.clientMessageId)
      expect(journal.receiptFor(accepted.clientMessageId)).not.toBeNull()
      await vi.waitFor(() => expect(db.getMessageById(report.id)?.delivered_at).not.toBeNull())
      delivery.onJournalActivity(SESSION)
      await vi.advanceTimersByTimeAsync(0)
      expect(journal.submissions()).toHaveLength(2)
      expect(db.getMessageById(old.id)?.delivered_at).toBeNull()
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(1)
    } finally {
      release()
      setStructuredAgentSessionHost(null)
      db.close()
    }
  })

  it.each(['full-access', 'ask'] as const)(
    'uses saved permission for a hidden continuation after acquisition in %s',
    async (acquired) => {
      const rig = get()
      if (acquired === 'ask') {
        await rig.host.close(SESSION, 'user-close')
        await rig.pick('ask')
      }
      const saved = acquired === 'ask' ? 'full-access' : 'ask'
      // The acquired process remains the same while per-turn policy changes.
      if (acquired === 'full-access') {
        await rig.pick(saved)
      }
      await root(rig)
      if (acquired === 'ask') {
        await rig.pick(saved)
      }
      const connection = rig.codex.connections.at(-1)!
      const opened = connection.calls.find(
        (call) => call.method === 'thread/start' || call.method === 'thread/resume'
      )!
      expect(opened.params?.sandbox).toBe(acquired === 'ask' ? 'read-only' : 'danger-full-access')
      clock()
      await fail(rig)
      expect(rig.host.currentWork(SESSION)?.working()).toBe(false)
      expect(rig.host.currentWork(SESSION)?.workingIncludingRetry()).toBe(true)
      expect(rig.host.readStatusSummary(SESSION)?.status).toBe('working')
      await startHidden(rig, 2_000, 1)
      expect(hidden(rig)[0]?.params).toMatchObject({
        input: [],
        model: 'gpt-live',
        effort: 'medium',
        serviceTier: 'default',
        approvalPolicy: saved === 'ask' ? 'on-request' : 'never',
        sandboxPolicy: { type: saved === 'ask' ? 'readOnly' : 'dangerFullAccess' }
      })
      expect(hidden(rig)[0]?.params).not.toHaveProperty('clientUserMessageId')
      rig.turns.end('completed')
      await flush(rig)
      expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
        status: 'idle',
        turnOutcome: 'success'
      })
    }
  )

  it.each([false, true])(
    'uses ordinary Auto preparation and terminates without acquisition spin when managed=%s',
    async (managed) => {
      const rig = get()
      await root(rig)
      await rig.pick('auto')
      rig.codex.routes['configRequirements/read'] = () => ({
        requirements: managed ? { sandbox_mode: 'workspace-write' } : null
      })
      clock()
      await fail(rig)
      await vi.advanceTimersByTimeAsync(2_000)
      if (managed || process.platform === 'win32') {
        expect(hidden(rig)).toHaveLength(0)
        expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
        expect(rig.codex.connections).toHaveLength(1)
      } else {
        expect(hidden(rig)).toHaveLength(1)
        expect(hidden(rig)[0]?.params).toMatchObject({
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true }
        })
        rig.turns.start()
        rig.turns.end('completed')
        await flush(rig)
      }
      await vi.advanceTimersByTimeAsync(90_000)
      expect(hidden(rig)).toHaveLength(managed || process.platform === 'win32' ? 0 : 1)
    }
  )

  it('settles five real hidden attempts once at 2/4/8/16/30 seconds, including terminal before reply', async () => {
    const rig = get()
    await root(rig)
    clock()
    await fail(rig)
    const before = journalOf(rig)
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
    for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      const release = rig.turns.holdNextAnswer()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(hidden(rig)).toHaveLength(index)
      await vi.advanceTimersByTimeAsync(1)
      expect(hidden(rig)).toHaveLength(index + 1)
      rig.turns.start()
      await fail(rig)
      release()
      await vi.advanceTimersByTimeAsync(0)
      await flush(rig)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hidden(rig)).toHaveLength(5)
    expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
      status: 'idle',
      turnOutcome: 'failure'
    })
    expect(
      journalOf(rig)
        .snapshot()
        .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
    ).toEqual(before)
  })

  it('joins a hidden terminal to its held start reply after an older settled attribution revision', async () => {
    const rig = get()
    await root(rig)
    const originalId = rig.turns.turnId!
    clock()
    await fail(rig)
    const journal = journalOf(rig)
    const identity = codexTurnLifecycleIdentity(SESSION, originalId)
    const original = journal.itemBody(agentJournalItemKey(identity))!
    const release = rig.turns.holdNextAnswer()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      rig.turns.start()
      await fail(rig)
      expect(hidden(rig)).toHaveLength(1)
      // The real journal writer's settled-attribution revision must not replace H's terminal.
      if (original.kind !== 'turn') {
        throw new Error('original root was not a turn')
      }
      await journal.appendItem(
        identity,
        { ...original, requestedAt: (original.requestedAt ?? 1) + 1 },
        { fence: rig.conversationFence(), turnScope: { kind: 'thread' } }
      )
      release()
      await vi.advanceTimersByTimeAsync(0)
      await startHidden(rig, 4_000, 2)
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(2)
      expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
        status: 'idle',
        turnOutcome: 'success'
      })
    } finally {
      release()
    }
  })

  it.each(['echo-before-terminal', 'echo-after-terminal'] as const)(
    'joins exact acceptance once with %s',
    async (order) => {
      const rig = get()
      const release = rig.turns.holdNextAnswer()
      const id = await rig.permissionSend('prove this exact opener')
      await vi.waitFor(() => expect(rig.starts()).toHaveLength(1))
      rig.turns.start()
      if (order === 'echo-before-terminal') {
        rig.turns.echo(id)
      }
      clock()
      await fail(rig)
      if (order === 'echo-after-terminal') {
        expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
        rig.turns.echo('wrong-client-id')
        await flush(rig)
        expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
        rig.turns.echo(id)
      }
      release()
      await flush(rig)
      await vi.waitFor(async () =>
        expect(await rig.row(id)).toMatchObject({ dispatchState: 'accepted' })
      )
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(true)
      rig.turns.echo(id)
      await startHidden(rig, 2_000, 1)
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(1)
    }
  )
}
