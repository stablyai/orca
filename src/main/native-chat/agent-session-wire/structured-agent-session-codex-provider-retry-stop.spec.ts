import { queuePauseHolding } from '../agent-session-journal/queued-message-pause'
import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'
import { structuredAgentSessionCanStop } from '../../../shared/structured-agent-session-stop-control'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import {
  CALLER,
  FAILURE,
  journalOf,
  hidden,
  clock,
  flush,
  fail,
  root
} from './structured-agent-session-codex-provider-retry-test-support'
import type { Rig } from './structured-agent-session-codex-provider-retry-test-support'

export function registerCodexRetryStop(get: () => Rig): void {
  it.each(['prepare', 'written', 'running'] as const)(
    'commits a fresh send and receipt before the old %s wait resolves',
    async (phase) => {
      const rig = get()
      await root(rig)
      const held = Promise.withResolvers<unknown>()
      const preparation = vi.fn(() => held.promise)
      if (phase === 'prepare') {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
        await rig.pick('auto')
        rig.codex.routes['config/read'] = preparation
      } else {
        const start = rig.codex.routes['turn/start']!
        rig.codex.routes['turn/start'] = (params) => {
          const answer = start(params)
          if (Array.isArray(params?.input) && params.input.length === 0) {
            return held.promise.then(() => answer)
          }
          return answer
        }
      }
      clock()
      await fail(rig)
      await vi.advanceTimersByTimeAsync(2_000)
      if (phase === 'prepare') {
        await vi.waitFor(() => expect(preparation).toHaveBeenCalledOnce())
      }
      if (phase === 'running') {
        rig.turns.start()
      }
      await flush(rig)
      const body = hostTestMessage('new accepted input supersedes the automatic claim')
      const fields = { body, delivery: 'queue-if-active' as const }
      const envelope = rig.envelope('agentSession.send', fields)
      const params = { envelope, userSend: true as const, ...fields }
      const result = await rig.host.send(CALLER, params)
      expect(result).toMatchObject({ ok: true })
      const receipt = rig.host.deps.store.readCommandReceipt(
        { kind: 'global' },
        envelope.clientOperationId
      )
      expect(receipt).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
      if (receipt.verdict !== 'readable' || receipt.receipt.status !== 'accepted') {
        throw new Error('host receipt missing')
      }
      if (receipt.receipt.result.kind === 'queued-draft') {
        expect(journalOf(rig).queuedMessages.get(receipt.receipt.result.messageId)).toBeDefined()
      } else {
        expect(journalOf(rig).submission(envelope.clientOperationId)).toBeDefined()
      }
      expect(await rig.host.send(CALLER, params)).toMatchObject({ ok: true, replayed: true })
      expect(
        rig.host.deps.store.readCommandReceipt({ kind: 'global' }, envelope.clientOperationId)
      ).toEqual(receipt)
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
      held.resolve(rig.config)
      await vi.advanceTimersByTimeAsync(0)
      // Actual positive work is the legitimate wake, rather than a retry bookkeeping poll.
      if (!result.ok) {
        throw new Error('fresh input was refused')
      }
      if (
        phase !== 'prepare' &&
        !rig
          .starts()
          .some((call) => call.params?.clientUserMessageId === result.value.clientMessageId)
      ) {
        if (phase === 'written') {
          rig.turns.start()
        }
        rig.turns.end('completed')
        await flush(rig)
      }
      const queued =
        receipt.receipt.result.kind === 'queued-draft'
          ? receipt.receipt.result.messageId
          : undefined
      let submitted = result.value.clientMessageId
      if (queued) {
        await vi.waitFor(() => {
          const handoffs = journalOf(rig)
            .submissions()
            .filter((entry) => entry.queuedMessageId === queued)
          expect(handoffs).toHaveLength(1)
          submitted = handoffs[0]!.clientMessageId
        })
        expect(submitted).not.toBe(queued)
      }
      await rig.began(submitted)
      expect(await rig.row(submitted)).toMatchObject({ dispatchState: 'accepted' })
      expect(journalOf(rig).receiptFor(submitted)).not.toBeNull()
      expect(
        rig.starts().filter((call) => call.params?.clientUserMessageId === submitted)
      ).toHaveLength(1)
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(phase === 'prepare' ? 0 : 1)
    }
  )

  it.each(['waiting', 'preparing', 'written', 'reply-no-open', 'late-open', 'running'] as const)(
    'Stop owns exact %s work and late provider events cannot escape',
    async (phase) => {
      const rig = get()
      await root(rig)
      const held = Promise.withResolvers<unknown>()
      const preparation = vi.fn(() => held.promise)
      if (phase === 'preparing') {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
        await rig.pick('auto')
        rig.codex.routes['config/read'] = preparation
      }
      if (phase === 'written') {
        rig.codex.routes['turn/start'] = () => held.promise
      }
      if (phase === 'late-open') {
        const connection = rig.codex.connections.at(-1)!
        const close = connection.close.bind(connection)
        connection.close = async () => {
          if (!connection.closed) {
            rig.turns.start()
          }
          return close()
        }
      }
      clock()
      await fail(rig)
      const connection = rig.codex.connections.at(-1)!
      if (phase !== 'waiting') {
        await vi.advanceTimersByTimeAsync(2_000)
      }
      if (phase === 'preparing') {
        await vi.waitFor(() => expect(preparation).toHaveBeenCalledOnce())
      }
      if (phase === 'running') {
        rig.turns.start()
      }
      expect(
        structuredAgentSessionCanStop({
          turnId: rig.host.currentWork(SESSION)?.activeTurnId() ?? null,
          isWorking: rig.host.currentWork(SESSION)!.workingIncludingRetry(),
          sending: false,
          stopsConversation: true
        })
      ).toBe(true)
      const stopping = rig.stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(await stopping).toMatchObject({ ok: true })
      if (phase === 'waiting' || phase === 'preparing') {
        expect(connection.closeCount).toBe(0)
        expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
          status: 'idle',
          turnOutcome: 'cancellation'
        })
      } else {
        expect(connection.closeCount).toBeGreaterThan(0)
      }
      held.resolve({ turn: { id: 'late-hidden' } })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
      expect(hidden(rig)).toHaveLength(phase === 'waiting' || phase === 'preparing' ? 0 : 1)
    }
  )

  it('retains an unproven hidden-start close, settles its late open, and joins proven closure before the next send', async () => {
    const rig = get()
    await root(rig)
    clock()
    await fail(rig)
    await vi.advanceTimersByTimeAsync(2_000)
    const connection = rig.codex.connections.at(-1)!
    const close = connection.close.bind(connection)
    let unproven = true
    connection.close = async () => {
      if (unproven) {
        unproven = false
        connection.closeCount++
        return false
      }
      return close()
    }
    try {
      const stopping = rig.stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(await stopping).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(connection.closeCount).toBe(1))
      const session = rig.host.collaboratorsForTests().sessions.get(SESSION)!
      expect(session.child?.close).toMatchObject({ cause: 'user-stop' })
      expect(connection.closed).toBe(false)
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
      rig.turns.start()
      rig.turns.end('interrupted')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(1)
      const id = await rig.permissionSend('normal send joins the old close')
      await rig.began(id)
      expect(connection.closed).toBe(true)
      expect(connection.closeCount).toBe(2)
      expect(rig.codex.connections).toHaveLength(2)
      rig.turns.end('completed')
      await flush(rig)
      expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
        status: 'idle',
        turnOutcome: 'success'
      })
    } finally {
      connection.close = close
    }
  })

  it.each(['end-before-stop', 'stop-before-end'] as const)(
    'preserves ordinary explicit failure with %s and accepts stale named/repeated Stops',
    async (order) => {
      const rig = get()
      await root(rig)
      const turnId = rig.turns.turnId!
      clock()
      if (order === 'end-before-stop') {
        rig.turns.end('failed', 'ordinary invalid request', 'invalidRequest')
        await flush(rig)
      } else {
        rig.codex.routes['turn/interrupt'] = () => {
          setTimeout(() => rig.turns.end('failed', 'ordinary invalid request', 'invalidRequest'), 4)
          return {}
        }
      }
      const stopping = rig.stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(await stopping).toMatchObject({ ok: true })
      await flush(rig)
      const journal = journalOf(rig)
      const key = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
      expect(journal.itemBody(key)).toMatchObject({ outcome: 'failure' })
      expect(await rig.stop(turnId)).toMatchObject({ ok: true })
      const second = rig.stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(await second).toMatchObject({ ok: true })
      expect(journal.itemBody(key)).toMatchObject({ outcome: 'failure' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(0)
    }
  )

  it('keeps the first exact retry-only Stop in force on an idle second Stop', async () => {
    const rig = get()
    await root(rig)
    const turnId = rig.turns.turnId
    clock()
    await fail(rig)
    expect(await rig.stop()).toMatchObject({ ok: true })
    const journal = journalOf(rig)
    const first = journal.queuedMessages.userStopInForce()!
    expect(first.event.turnId).toBe(turnId)
    const second = rig.stop()
    await vi.advanceTimersByTimeAsync(20)
    expect(await second).toMatchObject({ ok: true })
    expect(journal.queuedMessages.userStopInForce()?.sequence).toBe(first.sequence)
    expect(journal.itemBody(journal.stoppedTurnItemId(first.event.turnId!)!)).toMatchObject({
      outcome: 'cancellation'
    })
  })

  it.each(['intact', 'context-retained', 'context-removed'] as const)(
    'idle S2 preserves S1/cards/liveness with retry-only action %s',
    async (rewrite) => {
      const rig = get()
      if (rewrite !== 'intact') {
        const fields = { command: 'clear' as const }
        expect(
          await rig.host.conversationCommand(CALLER, {
            envelope: rig.envelope('agentSession.conversationCommand', fields),
            ...fields
          })
        ).toMatchObject({ ok: true })
      }
      await root(rig)
      clock()
      await fail(rig)
      expect(await rig.stop()).toMatchObject({ ok: true })
      const journal = journalOf(rig)
      const first = journal.queuedMessages.userStopInForce()!
      const { serialize } = rig.host.collaboratorsForTests()
      const key = { callerKey: CALLER.callerKey, editId: 'after-first-stop' }
      if (rewrite !== 'intact') {
        const kept =
          rewrite === 'context-removed'
            ? []
            : journal
                .snapshot()
                .items.filter((item) => item.body.kind === 'turn')
                .map((item) => {
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
        await journal.context.rewind(
          journal.context.floor()!,
          rig.conversationFence(),
          kept,
          () => ({ write: () => {}, committed: () => {} })
        )
        expect(journal.stopNamesCancelledTurn(first.event.turnId, first.sequence)).toBe(true)
        expect(journal.stoppedTurnItemId(first.event.turnId!)).toBeUndefined()
      }
      const card = await serialize(SESSION, async () => {
        const card = await journal.queuedMessages.insert({
          messageId: 'after-first-stop',
          body: hostTestMessage('new instruction after Stop')
        })
        expect(
          journal.queuedMessages.editLeases.acquire(key, {
            messageId: card.messageId,
            fingerprint: card.fingerprint
          })
        ).toMatchObject({ status: 'held' })
        return card
      })
      const stopping = rig.stop()
      await vi.advanceTimersByTimeAsync(20)
      expect(await stopping).toMatchObject({ ok: true })
      expect(journal.queuedMessages.userStopInForce()?.sequence).toBe(first.sequence)
      expect(queuePauseHolding(journal.queuedMessages.pauses(), card)).toBeUndefined()
      expect(
        await rig.host.queuedMessageEditHold(CALLER, {
          sessionId: SESSION,
          messageId: card.messageId,
          editId: key.editId,
          action: 'release'
        })
      ).toMatchObject({ status: 'released' })
      await vi.waitFor(() =>
        expect(journal.queuedMessages.get(card.messageId)?.consumedAs).toBeTruthy()
      )
      const id = journal.queuedMessages.get(card.messageId)!.consumedAs!
      await rig.began(id)
      rig.turns.end('completed')
      await flush(rig)
      expect(hidden(rig)).toHaveLength(0)
    }
  )

  it.each(['unauthorized', 'usageLimitReached', 'invalidRequest', 'other'])(
    'never starts automatic work for a final %s without typed transient proof',
    async (info) => {
      const rig = get()
      await root(rig)
      clock()
      rig.turns.end('failed', FAILURE, info)
      await flush(rig)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(hidden(rig)).toHaveLength(0)
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
    }
  )
}
