import { describe, expect, it } from 'vitest'
import type { BotChatCloseFacts } from '../../shared/bots/bot-chat-auto-close'
import { BotChatAutoClose } from './bot-chat-auto-close'
import { BotChatAutoCloseMarks } from './bot-chat-auto-close-marks'
import { deriveStructuredSessionMailReach } from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import type { LineageRunningSession } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

const START = 1_000_000
const TWO_MIN = 120_000

function quietFacts(): BotChatCloseFacts {
  return {
    chat: { origin: 'side', live: 'idle', runningTotal: 0, closed: false },
    room: false,
    items: { total: 2, open: 0, lastClosedAt: 900_000 },
    waits: 0,
    failedTurn: false,
    queuedMail: 0
  }
}

/** One host: a clock, its timers, the chat's facts and a marks file that outlives a restart. */
function makeHost(file: { text: string | null } = { text: null }) {
  let now = START
  let timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 0
  const facts: { current: BotChatCloseFacts | null } = { current: quietFacts() }
  const closes: string[] = []
  const reopens: string[] = []
  const marks = new BotChatAutoCloseMarks({
    read: async () => file.text,
    write: async (text) => {
      file.text = text
    }
  })
  const autoClose = new BotChatAutoClose({
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, run, id })
      return id
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
    facts: async () => facts.current,
    chatsWithItems: async () => ['chat-1'],
    botIds: () => ['bot-1'],
    close: async (_botId, chatId, by) => {
      closes.push(`${chatId}:${by}`)
      if (facts.current) {
        facts.current = { ...facts.current, chat: { ...facts.current.chat, closed: true } }
      }
    },
    reopen: async (_botId, chatId) => {
      reopens.push(chatId)
      if (facts.current) {
        facts.current = { ...facts.current, chat: { ...facts.current.chat, closed: false } }
      }
    },
    marks,
    changed: () => undefined
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) {
        break
      }
      timers = timers.filter((timer) => timer !== due)
      now = due.at
      due.run()
      await settle()
    }
    now = until
    await settle()
  }
  return { autoClose, facts, closes, reopens, advance, file, marks }
}

describe('BotChatAutoClose', () => {
  it('closes a quiet side chat whose items are all closed once its countdown runs out', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({
      phase: 'counting',
      closesAt: START + TWO_MIN
    })
    await host.advance(TWO_MIN - 5_000)
    expect(host.closes).toEqual([])
    await host.advance(5_000)
    expect(host.closes).toEqual(['chat-1:orca'])
    expect(host.autoClose.view('bot-1', 'chat-1')).toBeNull()
    expect(host.autoClose.autoClosedAt('bot-1', 'chat-1')).toBe(START + TWO_MIN)
  })

  it.each([
    ['Home Chat', { chat: { origin: 'home', live: 'idle', runningTotal: 0, closed: false } }],
    [
      'a Slack thread chat',
      { chat: { origin: 'slack', live: 'idle', runningTotal: 0, closed: false } }
    ],
    [
      'an automation chat',
      { chat: { origin: 'automation', live: 'idle', runningTotal: 0, closed: false } }
    ],
    ['a group room session', { room: true }],
    ['a chat that never had items', { items: { total: 0, open: 0, lastClosedAt: null } }],
    ['a chat with an open item', { items: { total: 2, open: 1, lastClosedAt: 900_000 } }],
    [
      'a chat with a live worker',
      { chat: { origin: 'side', live: 'idle', runningTotal: 1, closed: false } }
    ],
    [
      'a chat waiting on the owner',
      { chat: { origin: 'side', live: 'needs-you', runningTotal: 0, closed: false } }
    ],
    [
      'a replying chat',
      { chat: { origin: 'side', live: 'replying', runningTotal: 0, closed: false } }
    ],
    ['a chat with a pending wait', { waits: 1 }],
    ['a chat whose last turn failed', { failedTurn: true }],
    ['a chat with unread mail', { queuedMail: 1 }]
  ] as const)('never counts down for %s', async (_name, change) => {
    const host = makeHost()
    host.facts.current = { ...quietFacts(), ...change }
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.advance(TWO_MIN * 3)
    expect(host.autoClose.view('bot-1', 'chat-1')).toBeNull()
    expect(host.closes).toEqual([])
  })

  it('re-reads the chat when the countdown ends and stays open if work came back', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    host.facts.current = { ...quietFacts(), items: { total: 3, open: 1, lastClosedAt: 900_000 } }
    await host.advance(TWO_MIN)
    expect(host.closes).toEqual([])
    expect(host.autoClose.view('bot-1', 'chat-1')).toBeNull()
  })

  it('stops counting when a message reaches the chat', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.autoClose.turnStarted('bot-1', 'chat-1')
    await host.advance(TWO_MIN * 2)
    expect(host.closes).toEqual([])
  })

  it('starts counting when an item is canceled outside the chat', async () => {
    const host = makeHost()
    host.facts.current = { ...quietFacts(), items: { total: 1, open: 1, lastClosedAt: null } }
    await host.autoClose.evaluate('bot-1', 'chat-1')
    expect(host.autoClose.view('bot-1', 'chat-1')).toBeNull()
    host.facts.current = quietFacts()
    await host.autoClose.itemsChanged({ botIds: ['bot-1'], kinds: ['chats'] })
    expect(host.autoClose.view('bot-1', 'chat-1')).toBeNull()
    await host.autoClose.itemsChanged({ botIds: ['bot-1'], kinds: ['items'] })
    expect(host.autoClose.view('bot-1', 'chat-1')?.phase).toBe('counting')
  })

  it('pauses while a desktop holds the chat and starts over from the full time after', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.advance(60_000)
    await host.autoClose.hold('bot-1', 'chat-1', 'window-a', true)
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'held' })
    await host.advance(20_000)
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'held' })
    await host.autoClose.hold('bot-1', 'chat-1', 'window-a', false)
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({
      phase: 'counting',
      closesAt: START + 80_000 + TWO_MIN
    })
  })

  it('never closes a chat a desktop keeps holding, and resumes once the holds lapse', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.autoClose.hold('bot-1', 'chat-1', 'window-a', true)
    for (let renew = 0; renew < 20; renew++) {
      await host.advance(10_000)
      await host.autoClose.hold('bot-1', 'chat-1', 'window-a', true)
    }
    expect(host.closes).toEqual([])
    await host.advance(30_000)
    expect(host.autoClose.view('bot-1', 'chat-1')?.phase).toBe('counting')
  })

  it('shows one deadline to every device, and a hold or Keep open from one applies to all', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.autoClose.hold('bot-1', 'chat-1', 'window-b', false)
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({
      phase: 'counting',
      closesAt: START + TWO_MIN
    })
    await host.autoClose.hold('bot-1', 'chat-1', 'window-a', true)
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'held' })
    await host.autoClose.keepOpen('bot-1', 'chat-1')
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'kept' })
  })

  it('keeps a chat open across a restart until its items change', async () => {
    const first = makeHost()
    await first.autoClose.evaluate('bot-1', 'chat-1')
    await first.autoClose.keepOpen('bot-1', 'chat-1')
    first.autoClose.dispose()
    await first.marks.flushed()

    const relaunched = makeHost(first.file)
    await relaunched.autoClose.boot()
    await relaunched.advance(TWO_MIN * 2)
    expect(relaunched.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'kept' })
    expect(relaunched.closes).toEqual([])

    relaunched.facts.current = {
      ...quietFacts(),
      items: { total: 3, open: 0, lastClosedAt: 950_000 }
    }
    await relaunched.autoClose.itemsChanged({ botIds: ['bot-1'], kinds: ['items'] })
    expect(relaunched.autoClose.view('bot-1', 'chat-1')?.phase).toBe('counting')
  })

  it('reads the saved marks before its first change, so a turn before boot never writes over them', async () => {
    const first = makeHost()
    await first.autoClose.evaluate('bot-1', 'chat-1')
    await first.autoClose.keepOpen('bot-1', 'chat-1')
    await first.marks.flushed()

    const relaunched = makeHost(first.file)
    await relaunched.autoClose.evaluate('bot-1', 'chat-1')
    expect(relaunched.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'kept' })
  })

  it('starts a fresh countdown after a restart mid-countdown, never closing at boot', async () => {
    const first = makeHost()
    await first.autoClose.evaluate('bot-1', 'chat-1')
    await first.advance(TWO_MIN - 1_000)
    first.autoClose.dispose()
    await first.marks.flushed()

    const relaunched = makeHost(first.file)
    await relaunched.autoClose.boot()
    expect(relaunched.closes).toEqual([])
    expect(relaunched.autoClose.view('bot-1', 'chat-1')).toEqual({
      phase: 'counting',
      closesAt: START + TWO_MIN
    })
  })

  it('reopens the same chat kept open, so it stays open past the deadline and across a restart', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.advance(TWO_MIN)
    expect(host.closes).toEqual(['chat-1:orca'])

    await host.autoClose.reopen('bot-1', 'chat-1')
    expect(host.reopens).toEqual(['chat-1'])
    expect(host.autoClose.autoClosedAt('bot-1', 'chat-1')).toBeNull()
    await host.autoClose.turnEnded('bot-1', 'chat-1')
    await host.advance(TWO_MIN * 2)
    expect(host.closes).toEqual(['chat-1:orca'])
    expect(host.autoClose.view('bot-1', 'chat-1')).toEqual({ phase: 'kept' })

    await host.marks.flushed()
    const relaunched = makeHost(host.file)
    await relaunched.autoClose.boot()
    await relaunched.advance(TWO_MIN * 2)
    expect(relaunched.closes).toEqual([])
  })

  it('reopens a chat Orca closed when a message reaches it from any device', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.advance(TWO_MIN)
    await host.autoClose.turnStarted('bot-1', 'chat-1')
    expect(host.reopens).toEqual(['chat-1'])
    expect(host.autoClose.autoClosedAt('bot-1', 'chat-1')).toBeNull()
  })

  it('closes at once on Close now, as the owner’s close', async () => {
    const host = makeHost()
    await host.autoClose.evaluate('bot-1', 'chat-1')
    await host.autoClose.closeNow('bot-1', 'chat-1')
    expect(host.closes).toEqual(['chat-1:owner'])
    expect(host.autoClose.autoClosedAt('bot-1', 'chat-1')).toBeNull()
  })

  it('reopens the same session, whose waiting mail reaches it again once its tab shows', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mail reach reads only the live session id.
    const running = {
      kind: 'here',
      sessionId: 'chat-1',
      record: { sessionId: 'chat-1' },
      lineage: ['chat-1']
    } as unknown as LineageRunningSession
    const tabs = new Set(['chat-1'])
    const reach = () =>
      deriveStructuredSessionMailReach(
        running,
        () => true,
        () => ({ present: true, isListed: (id) => tabs.has(id) })
      )
    expect(reach()).toMatchObject({ kind: 'reachable', session: { sessionId: 'chat-1' } })
    // Closing removes the tab: its mail waits for the same session.
    tabs.delete('chat-1')
    expect(reach()).toEqual({ kind: 'ended', reason: 'closed' })
    // Reopen publishes the same session's tab again.
    tabs.add('chat-1')
    expect(reach()).toMatchObject({ kind: 'reachable', session: { sessionId: 'chat-1' } })
  })
})
