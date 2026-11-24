import { describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { BotRunChatCloseAfter } from '../../shared/bots/bot-run-chat-close'
import {
  BotRunChatCloser,
  type BotRunChatCloseDeps,
  type BotRunChatState
} from './bot-run-chat-close'

const HOUR = 60 * 60 * 1000

function botOf(id: string, runChatsCloseAfter?: BotRunChatCloseAfter): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the closer reads only id and runChatsCloseAfter.
  return { id, ...(runChatsCloseAfter ? { runChatsCloseAfter } : {}) } as Bot
}

function closerWith(input: {
  bots: Bot[]
  chats: Record<string, Omit<BotRunChatState, 'inUse'>>
  busy?: string[]
  inUse?: string[]
  /** Owes a reply from the start, or (`late`) only once its close is being admitted. */
  asked?: string[]
  /** What happens to a chat between the sweep's checks and its close. */
  late?: Record<string, 'asked' | 'opened'>
}) {
  let now = 0
  let file = ''
  let writes = 0
  const closed: string[] = []
  const owes = new Set(input.asked)
  const inUse = new Set(input.inUse)
  const deps: BotRunChatCloseDeps = {
    path: () => 'list.jsonl',
    read: async () => file,
    append: async (_path, text) => {
      file += text
      writes += 1
    },
    write: async (_path, text) => {
      file = text
      writes += 1
    },
    now: () => now,
    bots: () => input.bots,
    hostDefault: () => '24h',
    ready: async () => {},
    chat: (_bot, sessionId) => {
      const chat = input.chats[sessionId]
      return chat ? { ...chat, inUse: inUse.has(sessionId) } : null
    },
    automationChats: () => new Set(input.busy?.slice(0, 1)),
    busy: async (_bot, sessionId, automationChats) =>
      automationChats.has(sessionId) || input.busy?.includes(sessionId) === true,
    owesReply: (sessionId) => owes.has(sessionId),
    close: async (sessionId, admit) => {
      const late = input.late?.[sessionId]
      if (late) {
        ;(late === 'asked' ? owes : inUse).add(sessionId)
      }
      if (!admit()) {
        return false
      }
      closed.push(sessionId)
      return true
    }
  }
  const closer = new BotRunChatCloser(deps)
  return {
    closer,
    owes,
    /** A new launch reading the same list. */
    restart: () => new BotRunChatCloser(deps),
    closed,
    at: (ms: number) => {
      now = ms
    },
    writes: () => writes,
    lines: () => file.split('\n').filter(Boolean).length,
    parked: () => {
      const byChat = new Map<string, boolean>()
      for (const line of file.split('\n').filter(Boolean)) {
        const parsed = JSON.parse(line)
        byChat.set(String(parsed.sessionId), parsed.parked === true)
      }
      return [...byChat].flatMap(([id, parked]) => (parked ? [id] : []))
    },
    // Replays the list as a restart reads it: the last line for a chat wins.
    tracked: () => {
      const byChat = new Map<string, boolean>()
      for (const line of file.split('\n').filter(Boolean)) {
        const parsed = JSON.parse(line)
        byChat.set(String(parsed.sessionId), parsed.removed !== true)
      }
      return [...byChat].flatMap(([id, kept]) => (kept ? [id] : []))
    }
  }
}

describe('BotRunChatCloser', () => {
  it('closes only idle, unkept chats past their window, and every kept due chat moves on', async () => {
    const bots = [botOf('follows'), botOf('week', '7d'), botOf('never', 'never')]
    const run = closerWith({
      bots,
      chats: {
        due: { lastActivityAt: 0, kept: false },
        renamed: { lastActivityAt: 26 * HOUR, kept: false },
        linked: { lastActivityAt: 0, kept: true },
        working: { lastActivityAt: 0, kept: false },
        weekly: { lastActivityAt: 0, kept: false },
        forever: { lastActivityAt: 0, kept: false },
        otherProfile: { lastActivityAt: 0, kept: false },
        inTab: { lastActivityAt: 0, kept: false },
        asked: { lastActivityAt: 0, kept: false },
        askedLate: { lastActivityAt: 0, kept: false },
        openedLate: { lastActivityAt: 0, kept: false }
      },
      busy: ['working'],
      inUse: ['inTab'],
      asked: ['asked'],
      late: { askedLate: 'asked', openedLate: 'opened' }
    })
    for (const [bot, sessionId] of [
      [bots[0], 'due'],
      [bots[0], 'renamed'],
      [bots[0], 'linked'],
      [bots[0], 'working'],
      [bots[1], 'weekly'],
      [bots[2], 'forever'],
      [bots[0], 'gone'],
      [bots[0], 'inTab'],
      [bots[0], 'asked'],
      [bots[0], 'askedLate'],
      [bots[0], 'openedLate'],
      [botOf('elsewhere'), 'otherProfile']
    ] as const) {
      run.closer.arm(bot, sessionId)
    }
    run.at(25 * HOUR)
    await run.closer.sweep()
    const writes = run.writes()
    // Nothing kept is due again, so the timer doesn't refire into another sweep.
    await run.closer.sweep()
    // Only the chat with newer activity sets the timer: a held chat never wakes an idle Orca.
    const next = run.closer.nextSweepAt()
    run.closer.clear()

    expect(run.closed).toEqual(['due'])
    expect(run.tracked().sort()).toEqual([
      'asked',
      'askedLate',
      'inTab',
      'openedLate',
      'otherProfile',
      'renamed',
      'weekly',
      'working'
    ])
    expect(run.writes()).toBe(writes)
    expect(next).toBe(50 * HOUR)
  })

  it('keeps its list as long as its changes, not as long as every run ever armed', async () => {
    const bots = [botOf('follows'), botOf('other')]
    const run = closerWith({ bots, chats: {} })
    for (let index = 0; index < 3000; index += 1) {
      run.closer.arm(bots[0], `chat-${index % 5}`)
    }
    run.closer.arm(bots[1], 'kept')
    run.closer.forget('follows')
    await run.closer.sweep()
    run.closer.clear()

    expect(run.tracked().sort()).toEqual(['kept'])
    expect(run.lines()).toBeLessThanOrEqual(1001)
  })

  it('a parked chat sets no timer, and counts down again when what held it ends', async () => {
    const bots = [botOf('follows'), botOf('other')]
    const idle = { lastActivityAt: 0, kept: false }
    const run = closerWith({
      bots,
      chats: { asked: idle, item: idle, elsewhere: idle },
      asked: ['asked'],
      busy: ['unused', 'item', 'elsewhere']
    })
    run.closer.arm(bots[0], 'asked')
    run.closer.arm(bots[0], 'item')
    run.closer.arm(bots[1], 'elsewhere')
    run.at(25 * HOUR)
    await run.closer.sweep()
    const parkedTimer = run.closer.nextSweepAt()

    // Its answer came back, so its turn ended; another bot's item change wakes only that bot's.
    run.owes.delete('asked')
    run.at(30 * HOUR)
    run.closer.wake(['asked'])
    await run.closer.sweep()
    const afterTurn = run.parked()
    run.closer.itemsChanged(['follows'])
    await run.closer.sweep()
    const wokenTimer = run.closer.nextSweepAt()
    const stillParked = run.parked()
    run.closer.clear()
    // A new launch checks each parked chat once, then waits for its wake.
    const relaunch = run.restart()
    relaunch.rearm()
    await relaunch.sweep()
    const relaunchTimer = relaunch.nextSweepAt()
    run.at(49 * HOUR)
    await relaunch.sweep()
    const afterCheck = relaunch.nextSweepAt()
    relaunch.clear()

    expect(parkedTimer).toBeUndefined()
    expect(wokenTimer).toBe(54 * HOUR)
    expect(afterTurn.sort()).toEqual(['elsewhere', 'item'])
    expect(stillParked).toEqual(['elsewhere'])
    expect(run.closed).toEqual([])
    expect(relaunchTimer).toBe(49 * HOUR)
    expect(afterCheck).toBe(54 * HOUR)
  })
})
