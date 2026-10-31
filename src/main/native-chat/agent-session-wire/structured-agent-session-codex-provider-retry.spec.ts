import type { Rig } from './structured-agent-session-codex-provider-retry-test-support'
import type { StructuredAgentSessionRequestFailures } from './structured-agent-session-request-failures'
import { registerCodexRetryRetirement } from './structured-agent-session-codex-provider-retry-retirement.spec'
import { registerCodexRetryStop } from './structured-agent-session-codex-provider-retry-stop.spec'
import { registerCodexRetryAdmission } from './structured-agent-session-codex-provider-retry-admission.spec'
import { registerReleasedFailureReads } from './structured-agent-session-released-failure-read.spec'
import {
  CALLER,
  FAILURE,
  journalOf,
  hidden,
  clock,
  flush,
  fail,
  root,
  startHidden
} from './structured-agent-session-codex-provider-retry-test-support'
import { withEscalation } from './structured-agent-session-retry-completion-test-support'
import { JournalStoppedTurns } from '../agent-session-journal/journal-stopped-turns'
import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { selectStructuredAgentTurnBars } from '../../../shared/structured-agent-session-turn-timing'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { projectJournalBatch } from './agent-session-journal-batch'
import { createStructuredConversationCommandRunner } from '../../../shared/structured-conversation-command-send'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { sayAgentSessionFailureEnglish } from '../../../shared/agent-session-failure-copy'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import * as stopCuts from '../../../shared/native-chat/native-chat-orca-stop-cut'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from '../../runtime/orchestration/chat-worker-error-escalation'
import {
  structuredWorkerIdentities,
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from '../../runtime/structured-worker-identity'

const { structuredConversationCommandRunner } = createStructuredConversationCommandRunner({
  noticeText: agentSessionWriteNoticeEnglish,
  sayFailure: sayAgentSessionFailureEnglish
})

export function registerCodexProviderRetry(get: () => Rig): void {
  registerReleasedFailureReads(get)
  it.each(['prepare', 'written'] as const)(
    'admits conditional close once in the lane without cutting a refused %s retry',
    async (phase) => {
      const rig = get()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      await withEscalation(rig, async (mail, drain, _complete, notify) => {
        notify.mockImplementation(() => {
          expect(rig.host.hasSession(SESSION)).toBe(false)
        })
        await root(rig)
        const turnId = rig.turns.turnId!
        if (phase === 'prepare') {
          await rig.pick('auto')
        }
        const reply = Promise.withResolvers<unknown>()
        const entered = vi.fn(() => reply.promise)
        rig.codex.routes[phase === 'prepare' ? 'config/read' : 'turn/start'] = entered
        clock()
        await fail(rig)
        const retry = rig.host['providerRetry']
        const owner = retry['retries'].get(SESSION)!
        const baseline = rig.host['clientDelivery'].requestFailures['baselines'].get(SESSION)!
        const slot = baseline.deferred!
        const timer = owner.timer
        const currentResult = owner.currentResult
        const child = owner.child
        expect(timer).toBeDefined()
        expect(slot.owner).toBe(owner)
        const connection = rig.codex.connections.at(-1)!
        const retire = vi.spyOn(retry, 'retire')
        const clear = vi.spyOn(globalThis, 'clearTimeout')
        const aborts = rig.host['runtimeState'].acquireAborts
        const abort = aborts.abort.bind(aborts)
        const cut = vi.spyOn(aborts, 'abort').mockImplementation((...args) => {
          expect(retry['retries'].has(SESSION)).toBe(false)
          expect(baseline.deferred).toBeUndefined()
          return abort(...args)
        })
        const close = vi.spyOn(connection, 'close')
        const pending = () => {
          expect(retry['retries'].get(SESSION)).toBe(owner)
          expect(baseline.deferred).toBe(slot)
          expect(slot.owner).toBe(owner)
          expect(owner.currentResult).toBe(currentResult)
          expect(owner.abort.signal.aborted).toBe(false)
          expect(owner.child).toBe(child)
          expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBe(child)
          expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal).toBe(
            owner.journal
          )
          expect(connection.closed).toBe(false)
          expect(child.close).toBeUndefined()
          expect(retire).not.toHaveBeenCalled()
          expect(cut).not.toHaveBeenCalled()
          expect(close).not.toHaveBeenCalled()
          expect(rig.failures).toHaveLength(0)
        }
        const refuse = async (mode: 'false' | 'throw') => {
          const claim = {
            phase: owner.phase,
            written: owner.written,
            timer: owner.timer,
            attempt: owner.attempt,
            startedTurnRef: owner.startedTurnRef
          }
          const held = Promise.withResolvers<void>()
          const laneEntered = Promise.withResolvers<void>()
          const prior = rig.host['serialize'](SESSION, async () => {
            laneEntered.resolve()
            await held.promise
          })
          await laneEntered.promise
          const admit = vi.fn(() => {
            pending()
            if (mode === 'throw') {
              throw undefined
            }
            return false
          })
          const closing = rig.host.close(SESSION, 'evict', admit).then(
            () => ({ kind: 'returned' as const }),
            (error: unknown) => ({ kind: 'threw' as const, error })
          )
          try {
            await Promise.resolve()
            expect(admit).not.toHaveBeenCalled()
            pending()
            held.resolve()
            await prior
            const outcome = await closing
            expect(admit).toHaveBeenCalledOnce()
            if (mode === 'throw') {
              expect(outcome).toEqual({ kind: 'threw', error: undefined })
            } else {
              expect(outcome).toMatchObject({
                kind: 'threw',
                error: new Error('The user kept this chat open.')
              })
            }
            pending()
            expect(owner).toMatchObject(claim)
            await drain()
            expect(mail()).toHaveLength(0)
          } finally {
            held.resolve()
            await prior
            await closing
          }
        }
        let closing: Promise<void> | undefined
        let bodyFailed = false
        let bodyError: unknown
        const cleanupErrors: unknown[] = []
        try {
          await refuse('false')
          await refuse('throw')
          expect(owner.timer).toBe(timer)
          expect(clear).not.toHaveBeenCalledWith(timer)
          await vi.advanceTimersByTimeAsync(2_000)
          expect(entered).toHaveBeenCalledOnce()
          expect(owner.timer).toBeUndefined()
          expect(owner.phase).toBe('starting')
          expect(owner.written).toBe(phase === 'written')
          expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
          await refuse('false')
          await refuse('throw')
          const admit = vi.fn(() => {
            pending()
            return true
          })
          closing = rig.host.close(SESSION, 'evict', admit)
          await vi.advanceTimersByTimeAsync(0)
          expect(admit).toHaveBeenCalledOnce()
          expect(retire).toHaveBeenCalledWith(SESSION)
          expect(cut).toHaveBeenCalled()
          expect(owner.abort.signal.aborted).toBe(true)
          expect(baseline.deferred).toBeUndefined()
          reply.resolve(phase === 'prepare' ? rig.config : { turn: { id: 'closed-H' } })
          await closing
          expect(connection.closed).toBe(true)
          expect(rig.host.hasSession(SESSION)).toBe(false)
          await expect(owner.journal.readInOrder(() => null)).rejects.toMatchObject({
            code: 'journal_closed'
          })
          await drain()
          const id = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
          expect(rig.failures).toMatchObject([{ id, outcome: 'failure' }])
          expect(mail()).toHaveLength(1)
          expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({ requestId: id })
          expect(new Set(mail().map((message) => message.id)).size).toBe(1)
          expect(notify).toHaveBeenCalledOnce()
          await vi.advanceTimersByTimeAsync(90_000)
          expect(hidden(rig)).toHaveLength(phase === 'written' ? 1 : 0)
          expect(rig.failures).toHaveLength(1)
          expect(mail()).toHaveLength(1)
        } catch (error) {
          bodyFailed = true
          bodyError = error
        } finally {
          reply.resolve(rig.config)
          for (const cleanup of [
            () => closing,
            () => close.mockRestore(),
            () => cut.mockRestore(),
            () => clear.mockRestore(),
            () => retire.mockRestore()
          ]) {
            try {
              await cleanup()
            } catch (error) {
              cleanupErrors.push(error)
            }
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
            'conditional close witness cleanup failed'
          )
        }
        if (bodyFailed) {
          throw bodyError
        }
      })
    }
  )

  registerCodexRetryAdmission(get)

  registerCodexRetryStop(get)

  registerCodexRetryRetirement(get)

  it('keeps the stopped historical turn immutable through newer input, late attribution and item-only batches', async () => {
    const rig = get()
    const db = new OrchestrationDb(':memory:')
    const worker = structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: SESSION,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(SESSION),
      processIncarnation: `structured:${SESSION}`,
      worktreeId: 'workspace-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const run = db.createRun({
      objective: 'historical Stop',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    createRootDispatch(
      db,
      db.createTask({ spec: 'work', runId: run.id }).id,
      worker.handle,
      worker.paneKey
    )
    const onFailure = rig.host['deps'].onRequestFailure
    const escalations: Promise<void>[] = []
    rig.host['deps'].onRequestFailure = (failure) => {
      onFailure?.(failure)
      escalations.push(
        escalateChatWorkerError(failure, {
          getDb: () => db,
          isWaitingForMail: () => false,
          notify: () => {}
        })
      )
    }
    try {
      await root(rig)
      const turnId = rig.turns.turnId!
      clock()
      await fail(rig)
      const journal = journalOf(rig)
      const key = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
      const before = journal.item(key)!
      const cursor = journal.cursor()
      await rig.stop()
      const cancelled = journal.item(key)!
      expect(cancelled).toMatchObject({
        ...before,
        body: { ...before.body, state: 'interrupted', outcome: 'cancellation' }
      })
      expect(cancelled).not.toBe(before)
      const since = journal.readSince(cursor)
      if (!since.ok) {
        throw new Error(since.reset)
      }
      const rows = since.rows
      const batch = projectJournalBatch({
        rows,
        snapshot: journal.snapshot(),
        afterSequence: cursor.sequence,
        canonicalItemId: journal.canonicalItemId,
        stoppedTurnItemId: journal.stoppedTurnItemId
      })
      expect(batch.ok).toBe(true)
      if (!batch.ok) {
        throw new Error('missing effective batch')
      }
      expect(batch.batch.items).toContain(cancelled)
      // Deliberately omit all newer host status/latestTurn extensions for an older item-only client.
      const state = reduceStructuredAgentSession(
        {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          epoch: cursor.epoch,
          cursor,
          items: [before],
          submissions: journal.submissions()
        },
        { type: 'event', event: { type: 'batch', sessionId: SESSION, batch: batch.batch } }
      )
      expect(state.items.find((item) => item.itemId === key)?.body).toMatchObject({
        outcome: 'cancellation'
      })
      const timed = selectStructuredAgentTurnBars(
        journal.snapshot().items,
        journal.submissions(),
        null
      )
      expect(
        [...timed.settledTurns.values()].some((value) => value?.verdict === 'cancellation')
      ).toBe(true)
      const failuresAtStop = rig.failures.length
      for (const suffix of ['a', 'b']) {
        if (suffix === 'b') {
          const latest = await rig.permissionSend('newer user input')
          // T remains cancelled even before U's pending receipt becomes accepted.
          expect(journal.item(key)?.body).toMatchObject({ outcome: 'cancellation' })
          await rig.began(latest)
        }
        rig.notify('item/completed', {
          threadId: THREAD,
          turnId,
          item: { type: 'agentMessage', id: `late-${suffix}`, text: `late output ${suffix}` }
        })
        await flush(rig)
      }
      expect(rig.failures).toHaveLength(failuresAtStop)
      expect(rig.host.readStatusSummary(SESSION)?.status).toBe('working')
      rig.turns.end('completed')
      await flush(rig)
      expect(journal.item(key)?.body).toMatchObject({
        state: 'interrupted',
        outcome: 'cancellation'
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(0)
      await Promise.all(escalations)
      expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toHaveLength(0)
      // Prove the real dispatch/escalation binding is active, independently of dedupe.
      const next = await rig.permissionSend('a later real failure is still reported')
      await rig.began(next)
      rig.turns.end('failed', 'ordinary invalid request', 'invalidRequest')
      await flush(rig)
      await Promise.all(escalations)
      expect(rig.failures).toHaveLength(failuresAtStop + 1)
      expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toHaveLength(1)
    } finally {
      rig.host['deps'].onRequestFailure = onFailure
      await Promise.all(escalations)
      structuredWorkerIdentities.forget(worker.handle)
      db.close()
    }
  })

  it.each([100, 1_000])(
    'bounds new derivation work at actual producers/readers with %i retained roots',
    async (population) => {
      const rig = get()
      const journal = journalOf(rig)
      const observed = vi.spyOn(JournalStoppedTurns.prototype, 'observe')
      const targets = vi.spyOn(JournalStoppedTurns.prototype, 'target')
      const sessions = rig.host.collaboratorsForTests().sessions
      const session = sessions.get(SESSION)!
      const fence = rig.conversationFence()
      const identity = (recordId: string) => ({
        provider: 'legacy' as const,
        agent: 'codex',
        sessionId: SESSION,
        recordId
      })
      // Load saved history without pretending these accepted requests are new provider dispatches.
      sessions.delete(SESSION)
      try {
        for (let index = 0; index < population; index++) {
          const clientMessageId = `retained-${index}`
          await journal.appendSubmission({
            clientMessageId,
            payloadFingerprint: clientMessageId,
            body: hostTestMessage(`saved request ${index}`),
            fence
          })
          await journal.resolveDispatch({
            clientMessageId,
            state: 'accepted',
            providerIdentity: null,
            fence
          })
          const command = identity(`command-${index}`)
          await journal.appendLifecycleBatch({
            settlementId: clientMessageId,
            fence,
            mutations: [
              {
                kind: 'item',
                identity: identity(clientMessageId),
                body: {
                  kind: 'turn',
                  turnId: clientMessageId,
                  userItemId: agentJournalSubmissionKey(clientMessageId),
                  state: 'completed',
                  outcome: 'failure',
                  startedAt: 1_000,
                  completedAt: 4_000
                },
                turnScope: { kind: 'thread' }
              },
              {
                kind: 'item',
                identity: command,
                body: { ...hostTestMessage('/compact'), command: { name: 'compact' } },
                turnScope: { kind: 'thread' }
              },
              {
                kind: 'item',
                identity: identity(`command-turn-${index}`),
                body: {
                  kind: 'turn',
                  turnId: `command-turn-${index}`,
                  userItemId: agentJournalItemKey(command),
                  state: 'completed',
                  outcome: 'success'
                },
                turnScope: { kind: 'thread' }
              }
            ]
          })
          await journal.appendStopEvent({ reason: 'user-stop', turnId: clientMessageId }, fence)
        }
      } finally {
        sessions.set(SESSION, session)
      }
      expect(observed.mock.calls.length).toBeLessThanOrEqual(4 * population)
      expect(journal['state'].stoppedTurns['roots'].size).toBe(2 * population)
      expect(journal['state'].stoppedTurns['stopped'].size).toBe(population)
      // Adoption is one population pass, not N historical selections of N items.
      let phase = 'adoption'
      const operations = new Map<
        string,
        { phase: string; operation: string; callsite: string; argument: string; count: number }
      >()
      const count = (operation: string, argument: string) => {
        const callsite =
          new Error('retained-root operation attribution').stack
            ?.replaceAll('\\', '/')
            .split('\n')
            .find(
              (line) =>
                line.includes('/src/') &&
                !line.includes('structured-agent-session-codex-provider-retry.spec.ts')
            )
            ?.trim() ?? 'test-or-unattributed'
        const key = JSON.stringify([phase, operation, callsite, argument])
        const entry = operations.get(key) ?? { phase, operation, callsite, argument, count: 0 }
        entry.count++
        operations.set(key, entry)
      }
      const readBody = journal.itemBody
      const countedBodies = vi.spyOn(journal, 'itemBody').mockImplementation((id) => {
        count('itemBody', id)
        return readBody(id)
      })
      const readSnapshot = journal.snapshot
      const countedSnapshots = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
        const result = readSnapshot()
        count('snapshot', `items=${result.items.length},submissions=${result.submissions.length}`)
        return result
      })
      const visit = journal.visitItems
      const countedVisits = vi.spyOn(journal, 'visitItems').mockImplementation((visitor) =>
        visit((id, sequence, body) => {
          count('visitItem', id)
          visitor(id, sequence, body)
        })
      )
      const readFailures = rig.host['clientDelivery'].requestFailures.observe
      const countedFailures = vi
        .spyOn<StructuredAgentSessionRequestFailures, 'observe'>(
          rig.host['clientDelivery'].requestFailures,
          'observe'
        )
        .mockImplementation((id: string, current, rows, applied) => {
          count('failure-observe', `${id}:rows=${rows?.length ?? 'adoption'}`)
          return readFailures(id, current, rows, applied)
        })
      const publication = rig.host.observeJournalPublications(SESSION, () =>
        count('publication', SESSION)
      )
      const adoptionBodies = countedBodies
      try {
        rig.host['clientDelivery'].requestFailures.observe(SESSION, journal)
        expect(adoptionBodies.mock.calls.length).toBeLessThanOrEqual(4 * population)
        countedBodies.mockClear()
        phase = 'fresh-root-and-stop'
        await root(rig)
        const oldTurn = rig.turns.turnId!
        clock()
        await fail(rig)
        await rig.stop()
        countedSnapshots.mockClear()
        const snapshot = countedSnapshots
        countedBodies.mockClear()
        const bodies = countedBodies
        const latestSelection = vi.spyOn(stopCuts, 'latestNativeChatTurnSinceRequest')
        observed.mockClear()
        targets.mockClear()
        const callbackCount = rig.failures.length
        phase = 'output-only-and-readers'
        for (let index = 0; index < 20; index++) {
          rig.notify('item/completed', {
            threadId: THREAD,
            turnId: oldTurn,
            item: { type: 'agentMessage', id: `tail-${index}`, text: `late tail ${index}` }
          })
          await flush(rig)
          // All three former stopped-failure readers are live: work, status, request-failure observation.
          rig.host.currentWork(SESSION)?.publishedLatestTurn(null)
          rig.host.readStatusSummary(SESSION)
        }
        expect(rig.failures).toHaveLength(callbackCount)
        // No former stopped-failure reader rebuilds command membership during stream commits.
        expect(latestSelection).not.toHaveBeenCalled()
        latestSelection.mockRestore()
        phase = 'repeat-stop-and-death'
        const repeated = rig.stop()
        await vi.advanceTimersByTimeAsync(20)
        expect(await repeated).toMatchObject({ ok: true })
        phase = 'attribution-only'
        const oldIdentity = codexTurnLifecycleIdentity(SESSION, oldTurn)
        const oldBody = journal.itemBody(agentJournalItemKey(oldIdentity))!
        if (oldBody.kind !== 'turn') {
          throw new Error('stopped root missing')
        }
        const beforeRevision = observed.mock.calls.length
        await journal.appendItem(
          oldIdentity,
          { ...oldBody, requestedAt: (oldBody.requestedAt ?? 1) + 1 },
          { fence: rig.conversationFence(), turnScope: { kind: 'thread' } }
        )
        expect(observed.mock.calls.length - beforeRevision).toBe(1)
        expect(journal.itemBody(agentJournalItemKey(oldIdentity))).toMatchObject({
          outcome: 'cancellation'
        })
        phase = 'fresh-send-and-acquisition'
        const success = await rig.permissionSend('a later accepted success')
        await rig.began(success)
        phase = 'success'
        rig.turns.end('completed')
        await flush(rig)
        expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
          status: 'idle',
          turnOutcome: 'success'
        })
        const aggregateBodies = bodies.mock.calls.length
        const aggregateSnapshots = snapshot.mock.calls.length
        const snapshotItems = snapshot.mock.results.reduce(
          (sum, result) => sum + (result.type === 'return' ? result.value.items.length : 0),
          0
        )
        expect(observed.mock.calls.length).toBeLessThanOrEqual(80)
        expect(targets.mock.calls.length).toBeLessThanOrEqual(40)
        // Existing snapshot/sort/publication costs are population-sized, separately from derivation.
        expect(snapshot.mock.calls.length).toBeGreaterThan(0)
        expect(snapshot.mock.calls.length).toBeLessThanOrEqual(400)
        expect(
          snapshot.mock.results.reduce(
            (sum, result) => sum + (result.type === 'return' ? result.value.items.length : 0),
            0
          )
        ).toBeGreaterThanOrEqual(population)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(hidden(rig)).toHaveLength(0)
        phase = 'removal'
        const cancelled = journal.stoppedTurnItemId(oldTurn)!
        await journal.appendTombstone(codexTurnLifecycleIdentity(SESSION, oldTurn), {
          fence: rig.conversationFence()
        })
        expect(journal.item(cancelled)).toBeNull()
        expect(journal.stoppedTurnItemId(oldTurn)).toBeUndefined()
        expect(journal['state'].stoppedTurns['stopped'].size).toBe(population)
        phase = 'clear'
        const fields = { command: 'clear' as const }
        expect(
          await rig.host.conversationCommand(CALLER, {
            envelope: rig.envelope('agentSession.conversationCommand', fields),
            ...fields
          })
        ).toMatchObject({ ok: true })
        expect(rig.host.readStatusSummary(SESSION)?.turnOutcome).not.toBe('cancellation')
        phase = 'completion-admission'
        await root(rig)
        const recovering = rig.turns.turnId!
        await fail(rig)
        const completionStart = bodies.mock.calls.length
        phase = 'completion-output-and-readers'
        for (let index = 0; index < 20; index++) {
          rig.notify('item/completed', {
            threadId: THREAD,
            turnId: recovering,
            item: {
              type: 'agentMessage',
              id: `recovering-${index}`,
              text: 'exact late recovering output'
            }
          })
          await flush(rig)
          rig.host.currentWork(SESSION)?.publishedLatestTurn(null)
          rig.host.readStatusSummary(SESSION)
        }
        const completionBodies = bodies.mock.calls.length - completionStart
        phase = 'completion-success'
        await startHidden(rig, 2_000, 1)
        rig.turns.end('completed')
        await flush(rig)
        await vi.advanceTimersByTimeAsync(0)
        expect(
          rig.host['clientDelivery'].requestFailures['baselines'].get(SESSION)?.deferred
        ).toBeUndefined()
        expect(rig.host['providerRetry']['retries'].size).toBe(0)
        console.info(
          'provider-retry-scale-completion',
          JSON.stringify({ population, completionBodies })
        )
        expect(completionBodies).toBeLessThanOrEqual(800)
        console.info(
          'provider-retry-scale-aggregate',
          JSON.stringify({ population, aggregateBodies, aggregateSnapshots, snapshotItems })
        )
        // Keep the executed aggregate contract; attribution, not a guessed decomposition, decides any repair.
        expect(aggregateBodies).toBeLessThanOrEqual(800)
      } finally {
        console.info(
          'provider-retry-scale-operations',
          JSON.stringify({ population, operations: [...operations.values()] })
        )
        publication()
        countedFailures.mockRestore()
        countedVisits.mockRestore()
        countedSnapshots.mockRestore()
        countedBodies.mockRestore()
      }
    },
    60_000
  )

  it.each([false, true])(
    'actual desktop clear reaches ordinary host acceptance with retry display=%s, matching failed-idle behavior',
    async (retrying) => {
      const rig = get()
      await root(rig)
      clock()
      if (retrying) {
        await fail(rig)
      } else {
        rig.turns.end('failed', FAILURE, 'invalidRequest')
        await flush(rig)
      }
      const sent = vi.fn(async (command: 'clear' | 'compact') => {
        const fields = { command }
        const result = await rig.host.conversationCommand(CALLER, {
          envelope: rig.envelope('agentSession.conversationCommand', fields),
          ...fields
        })
        if (!result.ok) {
          throw new Error(JSON.stringify(result.refusal))
        }
        return { kind: 'done' as const, value: result.value }
      })
      const runner = structuredConversationCommandRunner({
        agentName: 'Codex',
        pending: { current: false },
        commandsWait: true,
        chat: {
          turnId: null,
          isWorking: retrying,
          queueSendsNext: false,
          submissions: journalOf(rig).submissions(),
          actualWorking: rig.host.currentWork(SESSION)!.working(),
          backgroundTasks: { isMonitoring: false, show: false }
        },
        prompts: [],
        rewindInFlight: { current: false },
        sends: [],
        items: () => journalOf(rig).snapshot().items,
        send: sent
      })
      expect(await runner.runConversationCommand('clear')).toMatchObject({ accepted: true })
      expect(sent).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(0)
    }
  )
}
