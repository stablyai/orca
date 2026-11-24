// While a shared agent's host is away, a chat shows what its host last streamed of it: the snapshot and
// the batches since, never a stream a reset ended, and only the reads a page opens with are answered.
import { describe, expect, it } from 'vitest'
import { PhoneSharedAgentKeptReads } from './phone-shared-agent-kept-reads'

const SUBSCRIBE = 'agentSession.subscribe'
const chat = { sessionId: 'chat-1' }

async function replayed(
  kept: PhoneSharedAgentKeptReads,
  params: unknown
): Promise<unknown[] | null> {
  const seen: unknown[] = []
  if (!kept.replay('share-1', SUBSCRIBE, params, (data) => seen.push(data))) {
    return null
  }
  await Promise.resolve()
  return seen
}

describe('a shared agent’s chat while its host is away', () => {
  it('replays the last snapshot and its batches, and nothing after a reset', async () => {
    const kept = new PhoneSharedAgentKeptReads()
    const passed: unknown[] = []
    const live = kept.recording('share-1', SUBSCRIBE, chat, (data) => passed.push(data))
    const events = [
      { type: 'batch', n: 0 },
      { type: 'snapshot', n: 1 },
      { type: 'batch', n: 2 },
      { type: 'error', n: 3 }
    ]
    events.forEach(live)
    expect(passed).toEqual(events)
    expect(await replayed(kept, chat)).toEqual([events[1], events[2]])
    expect(await replayed(kept, { sessionId: 'chat-2' })).toBeNull()
    // A chat closed before its replay runs gets nothing.
    const late: unknown[] = []
    kept.replay('share-1', SUBSCRIBE, chat, (data) => late.push(data))?.()
    await Promise.resolve()
    expect(late).toEqual([])

    live({ type: 'reset' })
    expect(await replayed(kept, chat)).toBeNull()
  })

  it('answers only the page’s opening reads, from a successful answer', () => {
    const kept = new PhoneSharedAgentKeptReads()
    const tree = { id: 'x', ok: true as const, result: { chats: [] } }
    kept.noteAnswer('share-1', 'bots.chatTree', { botId: 'b' }, tree)
    kept.noteAnswer('share-1', 'agentSession.send', {}, { id: 'y', ok: true, result: {} })
    expect(kept.answer('share-1', 'bots.chatTree', { botId: 'b' })).toBe(tree)
    expect(kept.answer('share-1', 'bots.chatTree', { botId: 'c' })).toBeUndefined()
    expect(kept.answer('share-1', 'agentSession.send', {})).toBeUndefined()
    // A share this phone no longer has keeps nothing.
    kept.forget('share-1')
    expect(kept.answer('share-1', 'bots.chatTree', { botId: 'b' })).toBeUndefined()
  })
})
