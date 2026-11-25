import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { createCodexDispatchEchoes } from '../../codex/structured/turns/codex-structured-dispatch-echo'
import { dispatchCodexTurn } from '../../codex/structured/turns/codex-structured-turn-start'
import type { CodexTurnHost } from '../../codex/structured/turns/codex-structured-turn-contract'
import { describe, expect, it } from 'vitest'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createStructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import { openJournal, receipt } from './journal-dispatch-written.test-fixture'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  measureHistoryItem,
  submissionBytesByItemId
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'look at this' }]
}

describe('a send the agent took', () => {
  it('stamps provider receipts once for the current handover, including steers', async () => {
    const journal = await openJournal()
    for (const clientMessageId of ['idle', 'steer', 'echoed', 'previous-fence']) {
      await journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: `fingerprint:${clientMessageId}`,
        body,
        fence: 2,
        handoverRecorded: true,
        origin: 'client'
      })
    }
    const { handoverCursor: idle } = await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    const { handoverCursor: steer } = await journal.prepareHandover({
      clientMessageId: 'steer',
      fence: 2,
      turnScope: { kind: 'turn', turnItemId: 'orca:turn-running' },
      body
    })
    const { handoverCursor: echoed } = await journal.prepareHandover({
      clientMessageId: 'echoed',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    const { handoverCursor: previousFence } = await journal.prepareHandover({
      clientMessageId: 'previous-fence',
      fence: 2,
      turnScope: { kind: 'thread' },
      body
    })
    await journal.resolveDispatch({
      clientMessageId: 'echoed',
      fence: 2,
      state: 'accepted',
      providerIdentity: null
    })

    const before = journal.cursor()
    await journal.markDispatchWritten({
      clientMessageId: 'idle',
      handoverCursor: { ...idle!, epoch: 'retired' },
      fence: 2,
      observedAt: 65
    })
    await journal.markDispatchWritten({
      clientMessageId: 'idle',
      handoverCursor: idle!,
      fence: 3,
      observedAt: 66
    })
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 1,
      observedAt: 70,
      providerReceipt: true
    })
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 71
    })
    await journal.markDispatchWritten({
      clientMessageId: 'echoed',
      handoverCursor: echoed!,
      fence: 2,
      observedAt: 72,
      providerReceipt: true
    })
    expect(journal.cursor()).toEqual(before)
    await journal.markDispatchWritten({
      clientMessageId: 'idle',
      handoverCursor: idle!,
      fence: 2,
      observedAt: 80
    })
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 81,
      providerReceipt: true
    })
    expect(journal.cursor().sequence).toBe(before.sequence)
    await journal.markDispatchWritten({
      clientMessageId: 'steer',
      handoverCursor: steer!,
      fence: 2,
      observedAt: 90,
      providerReceipt: true
    })
    expect(journal.cursor().sequence).toBe(before.sequence)

    expect(await receipt('idle')).toBe(80)
    expect(await receipt('steer')).toBe(81)
    expect(await receipt('echoed')).toBeUndefined()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'new-owner' },
      { kind: 'status', text: 'New owner' },
      { fence: 3, observedAt: 101, turnScope: { kind: 'thread' } }
    )
    await journal.markDispatchWritten({
      clientMessageId: 'previous-fence',
      handoverCursor: previousFence!,
      fence: 2,
      observedAt: 102
    })
    expect(await receipt('previous-fence')).toBeUndefined()
  })

  it('rejects a delayed provider callback after re-handover at the same fence and time', async () => {
    const journal = await openJournal()
    const input = {
      clientMessageId: 'retry',
      fence: 2,
      turnScope: { kind: 'thread' as const },
      body
    }
    await journal.appendSubmission({
      ...input,
      payloadFingerprint: 'retry',
      handoverRecorded: true,
      origin: 'client'
    })
    const first = await journal.prepareHandover(input)
    const next = await journal.prepareHandover(input)
    const at = journal.cursor()
    const delivery = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'session',
      logger: createStructuredAgentSessionLogger()
    })
    delivery.bind({ journal, fence: 2, publish: () => {} })
    const receive = (handoverCursor: typeof first.handoverCursor, observedAt: number) =>
      delivery.sink.recordProviderReceipt?.({
        clientMessageId: 'retry',
        fence: 2,
        handoverCursor: handoverCursor!,
        observedAt
      })
    try {
      receive(first.handoverCursor, 201)
      expect(await delivery.drained()).toEqual({ ok: true })
      expect(journal.cursor()).toEqual(at)
      expect(await receipt('retry')).toBeUndefined()

      receive(next.handoverCursor, 202)
      expect(await delivery.drained()).toEqual({ ok: true })
      expect(await receipt('retry')).toBe(202)
    } finally {
      delivery.close()
    }
  })

  it('stamps a matched fresh start after a refused steer races completion', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'parent' },
      { kind: 'turn', turnId: 'parent', state: 'running', startedAt: 100 },
      { fence: 2, observedAt: 100, turnScope: { kind: 'thread' } }
    )
    const delivery = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'session',
      logger: createStructuredAgentSessionLogger()
    })
    delivery.bind({ journal, fence: 2, publish: () => {} })
    const activeTurnIds = new Set(['parent'])
    const methods: string[] = []
    const request: CodexTurnHost['connection']['request'] = async (method, params, options) => {
      methods.push(method)
      if (method === 'turn/steer' && params?.clientUserMessageId === 'follow-up') {
        // The provider ended the turn. Its journal write is still racing this reply.
        activeTurnIds.delete('parent')
        throw new CodexAppServerRequestError(method, null, 'no active turn to steer')
      }
      const reply = { turn: { id: method === 'turn/steer' ? 'parent' : 'new-turn' } }
      options?.onReply?.(reply)
      return reply
    }
    const host = {
      connection: { request },
      threadId: 'thread',
      options: new Map<string, string>(),
      activeTurnIds,
      turnOpenWaits: { wait: async () => {} },
      dispatchEchoes: createCodexDispatchEchoes(() => {}),
      fence: 2,
      events: delivery.sink
    }
    try {
      for (const clientMessageId of ['steer', 'follow-up']) {
        await journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: clientMessageId,
          body,
          fence: 2,
          handoverRecorded: true,
          origin: 'client'
        })
        const input = { clientMessageId, fence: 2, body }
        let current = await journal.prepareHandover({
          ...input,
          turnScope: { kind: 'turn', turnItemId: 'orca:parent' }
        })
        const before = current.handoverCursor
        expect(
          await dispatchCodexTurn(
            host,
            {
              clientMessageId,
              sessionId: 'session',
              body,
              handoverCursor: () => current.handoverCursor,
              admitFreshInput: async (enqueue, _signal, kind) => {
                if (kind !== 'steer') {
                  current = await journal.prepareHandover({
                    ...input,
                    turnScope: { kind: 'thread' }
                  })
                  expect(current.turnScope).toEqual({ kind: 'turn', turnItemId: 'orca:parent' })
                  expect(current.handoverCursor).not.toEqual(before)
                }
                return enqueue('own', false)
              }
            },
            undefined
          )
        ).toMatchObject({ state: 'admitted' })
      }
      expect(await delivery.drained()).toEqual({ ok: true })
      expect(methods).toEqual(['turn/steer', 'turn/steer', 'turn/start'])
      expect(await receipt('steer')).toBeUndefined()
      expect(await receipt('follow-up')).toEqual(expect.any(Number))
      expect((await journal.reads.runningTurn())?.turnId).toBe('parent')
    } finally {
      delivery.close()
    }
  })

  it('keeps receipt and start ordered without adding a catch-up page at the byte limit', async () => {
    const journal = await openJournal(200)
    const cursor = journal.cursor()
    const opener = {
      ...body,
      blocks: [{ type: 'text' as const, text: 'u'.repeat(160_000) }]
    }
    await journal.appendSubmission({
      clientMessageId: 'idle',
      payloadFingerprint: 'fingerprint:idle',
      body: opener,
      fence: 2,
      handoverRecorded: true,
      origin: 'client'
    })
    const { handoverCursor } = await journal.prepareHandover({
      clientMessageId: 'idle',
      fence: 2,
      turnScope: { kind: 'thread' },
      body: opener
    })
    const readPage = async (budgetBytes: number, after = cursor) => {
      const result = (
        await journal.history({
          direction: 'after',
          cursor: after,
          reader: { form: 'client', budgetBytes }
        })
      ).result
      if (!result.ok) {
        throw new Error(`history reset: ${result.reset}`)
      }
      return result.page
    }
    const budget = BOUNDED_FRAME_CONTENT_BUDGET_BYTES
    const bodyWithText = (text: string) => ({
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text }]
    })
    const appendText = (id: string, text: string) =>
      journal.appendItem({ provider: 'orca', clientMessageId: id }, bodyWithText(text), {
        fence: 2,
        observedAt: 200,
        turnScope: { kind: 'thread' }
      })
    await appendText('a', 'a'.repeat(160_000))
    await appendText('b', 'b'.repeat(160_000))
    await appendText('fill', 'f')
    const widest = await readPage(budget)
    const total = (page: typeof widest) => {
      const sizes = submissionBytesByItemId(page.submissions)
      return page.items.reduce(
        (bytes, item) => bytes + measureHistoryItem(item).bytes + (sizes.get(item.itemId) ?? 0),
        0
      )
    }
    expect(widest.hasNewer).toBe(false)
    expect(widest.items.find((item) => item.itemId === 'orca:fill')).toBeDefined()
    let fill = 'f'.repeat(budget - total(widest) - 16)
    await appendText('fill', fill)
    const padded = await readPage(budget)
    fill += 'f'.repeat(budget - total(padded))
    await appendText('fill', fill)
    const before = await readPage(budget)
    expect(total(before)).toBe(budget)
    expect(before.hasNewer).toBe(false)

    const delivery = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'session',
      logger: createStructuredAgentSessionLogger()
    })
    delivery.bind({ journal, fence: 2, publish: () => {} })
    try {
      delivery.sink.recordProviderReceipt?.({
        clientMessageId: 'idle',
        fence: 2,
        handoverCursor: handoverCursor!,
        observedAt: 150
      })
      expect(await delivery.drained()).toEqual({ ok: true })
      expect(await receipt('idle')).toBe(150)
      const after = await readPage(budget)
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      delivery.sink.appendItem(
        { provider: 'orca', clientMessageId: 'turn' },
        { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:idle', startedAt: 175 },
        { turnScope: { kind: 'thread' } }
      )
      expect(await delivery.drained()).toEqual({ ok: true })
      const first = await readPage(budget)
      const next = await readPage(budget, first.window.nextCursor)
      expect(first.window.nextCursor).toEqual(before.window.nextCursor)
      expect(first.hasNewer).toBe(true)
      expect(next.items.map((item: AgentJournalRenderItem) => item.body)).toEqual([
        { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:idle', startedAt: 175 }
      ])
      expect(next.window.nextCursor.sequence).toBe(before.window.nextCursor.sequence + 1)
    } finally {
      delivery.close()
    }
  })
})
