// The close of one run chat under the bot's real lock, in its real order: the Home Chat, the recheck,
// the record, the stop, then the moves; and each later look that finishes what a failed move left.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { botChatSessions } from './bot-chat-session'
import {
  closeRunChatUnderLock,
  settleClosedRunChats,
  type RunChatCloseSteps
} from './bot-run-chat-close-step'

describe('closing one run chat under the bot lock', () => {
  /** `owed` stands for the database, so a second `sessions` over it is the same Orca restarted. */
  function sessions(
    closed: Awaited<ReturnType<RunChatCloseSteps['close']>>,
    owed = new Map<string, string>()
  ) {
    const calls: string[] = []
    const fail = { home: false, carry: false, handOver: false, drop: false, forget: false }
    /** Chats whose unread mail cannot even be looked at, which throws out of the whole finish. */
    const throwsFor = new Set<string>()
    const host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            id === 'home-chat' && !fail.home ? { provider: 'codex', sessionId: 'home-chat' } : null
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat lock reads only these fields of the bot.
    const bot = {
      id: 'bot-1',
      agent: 'codex',
      chatSessionId: 'home-chat',
      closeEndedRuns: true
    } as Bot
    const chats = botChatSessions({
      bots: { list: () => [bot], setChatSession: async () => bot },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening Home Chat reads only the store's conversation.
      host: async () => host as never,
      createChat: async () => {
        throw new Error('no Home Chat')
      },
      showTab: async () => {},
      closeChat: async () => ({ stopped: true }),
      dropUnreadMail: async () => {}
    })
    const steps: RunChatCloseSteps = {
      close: async (id) => {
        calls.push(`close ${id}`)
        return closed
      },
      // As the real move does, a card that stayed is told by its result, not thrown.
      carry: async (_host, from, to) => {
        if (fail.carry) {
          return false
        }
        calls.push(`carry ${from} -> ${to}`)
        return true
      },
      handOver: (from, to) => {
        if (fail.handOver) {
          throw new Error('hand over failed')
        }
        calls.push(`hand over ${from} -> ${to}`)
      },
      dropUnreadMail: (_bot, from) => {
        if (throwsFor.has(from)) {
          throw new Error('mail unreadable')
        }
        if (fail.drop) {
          return Promise.reject(new Error('drop failed'))
        }
        calls.push(`drop ${from}`)
        return Promise.resolve()
      },
      owed: {
        add: (botId, sessionId) => owed.set(sessionId, botId),
        forget: (sessionId) => {
          if (fail.forget) {
            throw new Error('database busy')
          }
          owed.delete(sessionId)
        },
        list: (botId) => [...owed].flatMap(([id, owner]) => (owner === botId ? [id] : []))
      },
      stopping: new Set<string>()
    }
    const close = (sessionId: string, ended: boolean, onRecheck: () => void = () => {}) =>
      closeRunChatUnderLock(chats, steps, 'bot-1', sessionId, async () => {
        onRecheck()
        return ended
      })
    /** The next look at the bot's chats: the sessions of those closed and of those open. */
    const settle = (closedChats: string[], openChats: string[] = []) =>
      settleClosedRunChats(chats, steps, 'bot-1', {
        closed: new Set(closedChats),
        open: new Set(openChats)
      })
    return { calls, close, settle, fail, throwsFor, bot, owed, stopping: steps.stopping }
  }

  const moves = (id: string) => [
    `carry ${id} -> home-chat`,
    `hand over ${id} -> home-chat`,
    `drop ${id}`
  ]

  it('closes, then moves what was queued and coordinated there to the Home Chat', async () => {
    const { calls, close, owed } = sessions({ stopped: true })
    await expect(close('run-chat', true)).resolves.toBe('closed')
    expect(calls).toEqual(['close run-chat', ...moves('run-chat')])
    expect(owed.size).toBe(0)
  })

  it('leaves the chat and its mail alone when the recheck keeps it, the setting went off, or the close is refused', async () => {
    const kept = sessions({ stopped: true })
    await expect(kept.close('run-chat', false)).resolves.toBe('kept')
    await expect(kept.close('home-chat', true)).resolves.toBe('kept')
    kept.bot.closeEndedRuns = false
    await expect(kept.close('run-chat', true)).resolves.toBe('kept')
    expect(kept.calls).toEqual([])

    const refused = sessions({ stopped: false })
    await expect(refused.close('run-chat', true)).resolves.toBe('failed')
    expect(refused.calls).toEqual(['close run-chat'])
    expect(refused.owed.size).toBe(0)

    // A tab that came to the front since the recheck refused it at the close's last word.
    const shown = sessions({ stopped: false, tabInFront: true })
    await expect(shown.close('run-chat', true)).resolves.toBe('tab-in-front')
    expect(shown.calls).toEqual(['close run-chat'])
    expect(shown.owed.size).toBe(0)
  })

  it('leaves the run chat open when the Home Chat cannot open', async () => {
    const { calls, close, fail } = sessions({ stopped: true })
    fail.home = true
    await expect(close('run-chat', true, () => calls.push('recheck'))).rejects.toThrow(
      'no Home Chat'
    )
    // Opened before the recheck, which is then the last read before the stop.
    expect(calls).toEqual([])
  })

  it('finishes on a later look every move a failed one left, after a restart too', async () => {
    const owed = new Map<string, string>()
    const before = sessions({ stopped: true }, owed)
    const carried = randomUUID()
    before.fail.carry = true
    await expect(before.close(carried, true)).resolves.toBe('closed')
    // The Runs and the senders still went on; the cards wait for the next look.
    expect(before.calls).toEqual([`close ${carried}`, ...moves(carried).slice(1)])
    // Restarted: nothing of the first Orca is left but what the database kept.
    const { calls, settle } = sessions({ stopped: true }, owed)
    await settle([carried, randomUUID()])
    expect(calls).toEqual(moves(carried))
    calls.length = 0
    await settle([carried])
    expect(calls).toEqual([])
  })

  it('keeps the record until the Runs and the senders went on too, and a failed forget holds up nothing', async () => {
    const handOver = sessions({ stopped: true })
    handOver.fail.handOver = true
    await expect(handOver.close('run-chat', true)).resolves.toBe('closed')
    expect(handOver.calls).toEqual([
      'close run-chat',
      'carry run-chat -> home-chat',
      'drop run-chat'
    ])
    handOver.fail.handOver = false
    handOver.calls.length = 0
    await handOver.settle(['run-chat'])
    expect(handOver.calls).toEqual(moves('run-chat'))
    expect(handOver.owed.size).toBe(0)

    const drop = sessions({ stopped: true })
    drop.fail.drop = true
    await expect(drop.close('run-chat', true)).resolves.toBe('closed')
    expect(drop.owed.size).toBe(1)
    drop.fail.drop = false
    drop.calls.length = 0
    await drop.settle(['run-chat'])
    expect(drop.calls).toEqual(moves('run-chat'))
    expect(drop.owed.size).toBe(0)

    const forget = sessions({ stopped: true })
    forget.fail.forget = true
    await expect(forget.close('run-chat', true)).resolves.toBe('closed')
    expect(forget.calls).toEqual(['close run-chat', ...moves('run-chat')])
    expect(forget.owed.size).toBe(1)
  })

  it('closes a chat whose agent was still starting once that start ends, and moves what it left then', async () => {
    let startEnds: (stopped: boolean) => void = () => {}
    const whenStopped = new Promise<boolean>((resolve) => (startEnds = resolve))
    const starting = sessions({ stopped: false, whenStopped })
    await expect(starting.close('run-chat', true)).resolves.toBe('stopping')
    expect(starting.calls).toEqual(['close run-chat'])
    expect(starting.owed.size).toBe(1)
    startEnds(true)
    await vi.waitFor(() => expect(starting.owed.size).toBe(0))
    expect(starting.calls).toEqual(['close run-chat', ...moves('run-chat')])
    expect(starting.stopping.size).toBe(0)

    // A start that ended with no proof the chat closed leaves the record for the next look to judge.
    const unproven = Promise.resolve(false)
    const unprovenClose = sessions({ stopped: false, whenStopped: unproven })
    await expect(unprovenClose.close('run-chat', true)).resolves.toBe('stopping')
    await unproven
    expect(unprovenClose.calls).toEqual(['close run-chat'])
    expect(unprovenClose.owed.size).toBe(1)
    // That look finds it open and drops the record.
    await unprovenClose.settle([], ['run-chat'])
    expect(unprovenClose.owed.size).toBe(0)
  })

  it('keeps the record of a chat whose stop waits for its start while it reads open, and after a move failed', async () => {
    let startEnds: (stopped: boolean) => void = () => {}
    const whenStopped = new Promise<boolean>((resolve) => (startEnds = resolve))
    const { calls, close, settle, fail, owed } = sessions({ stopped: false, whenStopped })
    await expect(close('run-chat', true)).resolves.toBe('stopping')
    // It reads open until its agent's start ends.
    await settle([], ['run-chat'])
    expect(owed.size).toBe(1)
    fail.carry = true
    startEnds(true)
    await vi.waitFor(() => expect(calls).toContain('drop run-chat'))
    // A look that read the chat before it closed still finds it open.
    await settle([], ['run-chat'])
    expect(owed.size).toBe(1)
    fail.carry = false
    calls.length = 0
    await settle(['run-chat'])
    expect(calls).toEqual(moves('run-chat'))
    expect(owed.size).toBe(0)
  })

  it('keeps the record when a later look is refused while an earlier stop still waits for its start', async () => {
    let startEnds: (stopped: boolean) => void = () => {}
    const result: Awaited<ReturnType<RunChatCloseSteps['close']>> = {
      stopped: false,
      whenStopped: new Promise<boolean>((resolve) => (startEnds = resolve))
    }
    const { calls, close, settle, fail, owed } = sessions(result)
    await expect(close('run-chat', true)).resolves.toBe('stopping')
    // The next look's stop is refused, its tab now in front; the first stop still goes on.
    delete result.whenStopped
    result.tabInFront = true
    await expect(close('run-chat', true)).resolves.toBe('tab-in-front')
    expect(owed.size).toBe(1)
    fail.carry = true
    startEnds(true)
    await vi.waitFor(() => expect(calls).toContain('drop run-chat'))
    expect(owed.size).toBe(1)
    fail.carry = false
    calls.length = 0
    await settle(['run-chat'])
    expect(calls).toEqual(moves('run-chat'))
    expect(owed.size).toBe(0)
  })

  it('holds up nothing on a record it cannot drop: a tab in front still refuses as tab-in-front, and the next records settle', async () => {
    const shown = sessions({ stopped: false, tabInFront: true })
    shown.fail.forget = true
    await expect(shown.close('run-chat', true)).resolves.toBe('tab-in-front')
    expect(shown.owed.size).toBe(1)

    const owed = new Map([
      ['reopened', 'bot-1'],
      ['run-chat', 'bot-1']
    ])
    const { calls, settle, fail } = sessions({ stopped: true }, owed)
    fail.forget = true
    await settle(['run-chat'], ['reopened'])
    expect(calls).toEqual(moves('run-chat'))
  })

  it('drops the record of a chat open again, or never closed, and moves nothing of it', async () => {
    const owed = new Map([
      ['reopened', 'bot-1'],
      ['not-found', 'bot-1']
    ])
    const { calls, settle } = sessions({ stopped: true }, owed)
    await settle([], ['reopened'])
    expect(calls).toEqual([])
    expect([...owed.keys()]).toEqual(['not-found'])
  })

  it('goes on to the other closed run chats when one cannot be finished', async () => {
    const owed = new Map<string, string>()
    const { calls, settle, throwsFor } = sessions({ stopped: true }, owed)
    const stuck = randomUUID()
    const next = randomUUID()
    owed.set(stuck, 'bot-1').set(next, 'bot-1')
    throwsFor.add(stuck)
    await settle([stuck, next])
    expect(calls).toEqual([...moves(stuck).slice(0, 2), ...moves(next)])
    expect([...owed.keys()]).toEqual([stuck])
  })
})
