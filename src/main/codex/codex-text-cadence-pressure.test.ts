import { afterEach, expect, it, vi } from 'vitest'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { codexItemIdentity, CodexTurnOrdinals } from './codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

afterEach(closeCheckpointTestJournals)

const P = 'P'.repeat(100)
const T = 'T'.repeat(64)

async function evictionRig() {
  const r = await checkpointJournalRig()
  r.translator.dispose()
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const translator = createCodexJournalTranslator({
    sink: r.deferred.sink,
    bindPromptItemId: () => {},
    primaryThreadId: () => null,
    isCurrent: () => true
  })
  const notify = (method: string, params: unknown) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params
    })
  const row = (id: string, journal = r.journal, type = 'agentMessage') =>
    journal.item(
      agentJournalItemKey(
        codexItemIdentity({
          threadId: 'thread',
          turnId: null,
          item: { type, id },
          ordinals: new CodexTurnOrdinals()
        })
      )
    )
  const text = (id: string, journal = r.journal, type = 'agentMessage') => {
    const body = row(id, journal, type)?.body
    if (body?.kind === 'status') {
      return body.text
    }
    return body?.kind === 'message' && body.blocks[0]?.type === 'text'
      ? body.blocks[0].text
      : undefined
  }
  const tick = async (ms = 60) => {
    await vi.advanceTimersByTimeAsync(ms)
    await r.deferred.drained()
  }
  vi.advanceTimersByTime(60)
  return { r, translator, notify, row, text, tick }
}

it.each(['agentMessage', 'plan'] as const)(
  'saves a time-gated $type tail before an incoming stream evicts its buffer',
  async (type) => {
    const method = type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta'
    const h = await evictionRig()
    for (let i = 0; i < 256; i++) {
      expect(h.notify(method, { itemId: `m${i}`, delta: P })).toEqual({ accepted: true })
      h.translator.flush()
      await h.r.deferred.drained()
    }
    const first = h.row('m0', h.r.journal, type)
    vi.advanceTimersByTime(40)
    h.notify(method, { itemId: 'm0', delta: T })
    await h.tick()
    // Inside the 400 ms window, so the tail is only buffered.
    expect(h.text('m0', h.r.journal, type)).toBe(P)
    expect(h.notify(method, { itemId: 'm256', delta: 'incoming' })).toEqual({ accepted: true })
    await h.r.deferred.drained()
    expect(h.text('m0', h.r.journal, type)).toBe(P + T)
    await h.tick()
    expect(h.text('m256', h.r.journal, type)).toBe('incoming')
    expect(h.row('m0', h.r.journal, type)).toMatchObject({
      itemId: first?.itemId,
      sequence: first?.sequence,
      observedAt: first?.observedAt
    })
    h.translator.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await h.r.journal.close()
    const reopened = await h.r.reopen()
    expect(h.text('m0', reopened, type)).toBe(P + T)
    expect(h.text('m256', reopened, type)).toBe('incoming')
  }
)
