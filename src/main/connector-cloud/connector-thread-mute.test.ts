import { describe, expect, it } from 'vitest'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { ConversationChain } from '../external-conversations/external-conversation-chain'
import { dispatchDelivery } from './connector-deliveries'
import { dispatchBatch } from './connector-delivery-batches'
import { handleThreadMute, threadMuteStep } from './connector-thread-mute'
import { threadMuteCommand } from './connector-thread-mute-phrases'

const conversation = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' }
const send = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'send',
  deliveryId: `d-${Math.random()}`,
  expiresAt: 1_900_000_000_000,
  conversation,
  text,
  asker: {
    userId: 'U1',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' },
    text,
    context: [],
    messageRef: 'slack:T1:C1:1800000000.000100:1800000000.000200'
  },
  ...extra
})

describe('threadMuteCommand', () => {
  const bot = { userId: 'U0BOT', names: ['Reviewer bot', 'reviewer'] }
  it('reads only a whole message addressed to this bot as a command', () => {
    expect(threadMuteCommand('mute', bot)).toBe('mute')
    expect(threadMuteCommand('<@U0BOT> Be quiet!', bot)).toBe('mute')
    expect(threadMuteCommand('<@U0BOT> reviewer stop responding in this thread', bot)).toBe('mute')
    expect(threadMuteCommand('@Orca reviewer please unmute 🔊', bot)).toBe('unmute')
    expect(threadMuteCommand('Start responding again.', bot)).toBe('unmute')
    // A numbered handle is matched whole, never as its bot's shorter name.
    expect(
      threadMuteCommand('<@U0BOT> reviewer-2 mute', {
        userId: 'U0BOT',
        names: ['reviewer', 'reviewer-2']
      })
    ).toBe('mute')
    // Someone else's mute, a question, or a sentence that only contains the word.
    expect(threadMuteCommand('<@UOTHER> mute', bot)).toBeNull()
    expect(threadMuteCommand('@bob be quiet', bot)).toBeNull()
    expect(threadMuteCommand('mute?', bot)).toBeNull()
    expect(threadMuteCommand('mute?! 🤔', bot)).toBeNull()
    expect(threadMuteCommand('`mute`', bot)).toBeNull()
    expect(threadMuteCommand("don't mute", bot)).toBeNull()
    expect(threadMuteCommand('mute the video player', bot)).toBeNull()
  })
})

describe('a mention in a muted thread', () => {
  it('unmutes only for this bot’s own whole name', () => {
    const bot = { userId: 'U0BOT', names: ['reviewer'] }
    const step = (text: string) => threadMuteStep(true, { text }, bot)
    expect(step('ping @reviewer, look')).toBe('unmute_and_send')
    expect(step('ping @reviewer-2')).toBe('silence')
    expect(step('@reviewer-2 hello')).toBe('silence')
    // The person's own words decide, not the thread context an older Orca's text carries with them.
    const withContext = { text: 'earlier: can you look?\n\nunmute', asker: { text: 'unmute' } }
    expect(threadMuteStep(true, withContext, bot)).toBe('unmute')
    expect(step('send it to ops@reviewer.io')).toBe('silence')
    expect(step('the example username is `@reviewer`')).toBe('silence')
    expect(step('```\n<@U0BOT> hi\n```')).toBe('silence')
  })
})

describe('a muted thread', () => {
  // Muting is decided before the agent: once muted, only a mention or "unmute" reaches the chat.
  it('keeps unmentioned replies from the agent until a mention or unmute', async () => {
    let muted = false
    const reacted: string[] = []
    const reached: string[] = []
    const seam = {
      send: async (_host: unknown, _key: unknown, _id: string, message: { text: string }) => {
        reached.push(message.text)
        return { outcome: 'accepted' }
      },
      receipts: {
        run: (_k: unknown, _d: unknown, _m: unknown, _t: unknown, run: () => unknown) => run(),
        known: () => false,
        heldByMute: () => null
      }
    } as unknown as ExternalConversationSeam
    const machine = {
      runTrigger: async () => false,
      threadMute: (
        delivery: Parameters<typeof handleThreadMute>[1],
        record: Parameters<typeof handleThreadMute>[2]
      ) =>
        handleThreadMute(
          {
            read: () => ({ botId: 'bot1', muted }),
            write: async (_key, next) => {
              muted = next
            },
            botNames: () => ['reviewer'],
            otherBotNames: () => ['reviewer-2'],
            queued: async () => {},
            waiting: new Map(),
            react: async (_bot, _key, _ref, emoji) => {
              reacted.push(emoji)
            }
          },
          delivery,
          record
        )
    }
    const deliver = async (raw: unknown) => {
      const dispatched = dispatchDelivery(
        seam,
        {} as ExternalConversationHost,
        machine,
        raw,
        () => 60_000
      )
      return await dispatched?.done
    }

    await deliver(send('first'))
    expect(await deliver(send('<@U0BOT> mute'))).toEqual({ outcome: 'accepted' })
    await deliver(send('anyone there?'))
    await deliver(send('hello again', { mentioned: true }))
    await deliver(send('mute'))
    await deliver(send('ping @reviewer'))
    await deliver(send('mute'))
    await deliver(send('<@UOTHER> unmute'))
    // Another bot behind the same Slack app: its mute is no mention of this one.
    await deliver(send('<@U0BOT> reviewer-2 mute'))
    await deliver(send('still muted'))
    await deliver(send('unmute'))
    await deliver(send('back'))

    expect(reached).toEqual(['first', 'hello again', 'ping @reviewer', 'back'])
    expect(reacted).toEqual([':mute:', ':mute:', ':mute:', ':loud_sound:'])
    expect(muted).toBe(false)
  })
})

describe('a reply in the same poll as its thread’s start', () => {
  // The start writes the thread's link only once its queued delivery runs: its replies wait for it,
  // then a mute mutes and anything else goes on to the chat.
  const replyAfterStart = async (text: string, waiting = new Map<string, Promise<unknown>>()) => {
    let linked = false
    let muted = false
    const outcome = handleThreadMute(
      {
        read: () => (linked ? { botId: 'bot1', muted } : null),
        write: async (_key, next) => {
          muted = next
        },
        botNames: () => [],
        otherBotNames: () => [],
        queued: async () => {
          linked = true
        },
        waiting,
        react: async () => {}
      },
      send(text) as Parameters<typeof handleThreadMute>[1],
      (handled) => handled()
    )
    const result = outcome ? await outcome.decided : null
    return { result, muted }
  }

  it('mutes on a mute and sends anything else on', async () => {
    expect(await replyAfterStart('mute')).toEqual({ result: { outcome: 'accepted' }, muted: true })
    expect(await replyAfterStart('@sam be quiet')).toEqual({ result: 'send', muted: false })
    // An ordinary reply goes on at once, batched as ever, unless one waits ahead of it.
    expect(await replyAfterStart('later reply')).toEqual({ result: null, muted: false })
    const behind = new Map([
      [JSON.stringify(['slack', conversation.externalId]), Promise.resolve()]
    ])
    expect(await replyAfterStart('later reply', behind)).toEqual({ result: 'send', muted: false })
  })
})

describe('a resent delivery', () => {
  // A delivery this machine already took replays its receipt: a resent old mention never undoes a
  // newer mute, and a resent silenced reply never reaches the chat because the thread was unmuted.
  it('never decides the mute again', async () => {
    let muted = true
    const reached: string[] = []
    const seam = {
      send: async (_host: unknown, _key: unknown, _id: string, message: { text: string }) => {
        reached.push(message.text)
        return { outcome: 'accepted' }
      },
      receipts: { known: () => true, heldByMute: () => null }
    } as unknown as ExternalConversationSeam
    const machine = {
      runTrigger: async () => false,
      threadMute: (
        delivery: Parameters<typeof handleThreadMute>[1],
        record: Parameters<typeof handleThreadMute>[2]
      ) =>
        handleThreadMute(
          {
            read: () => ({ botId: 'bot1', muted }),
            write: async (_key, next) => {
              muted = next
            },
            botNames: () => [],
            otherBotNames: () => [],
            queued: async () => {},
            waiting: new Map(),
            react: async () => {}
          },
          delivery,
          record
        )
    }
    const resent = dispatchDelivery(
      seam,
      {} as ExternalConversationHost,
      machine,
      send('<@U0BOT> look', { mentioned: true }),
      () => 60_000
    )
    await resent?.done
    expect(muted).toBe(true)
    expect(reached).toEqual(['<@U0BOT> look'])
  })
})

describe('a mention that unmutes, with follow-ups in its poll', () => {
  // The unmute is saved before the mention goes on, and its follow-ups still go with it as one turn.
  it('reaches the chat once, carrying them', async () => {
    let muted = true
    const turns: { text: string; later: number }[] = []
    const seam = {
      send: async (
        _host: unknown,
        _key: unknown,
        _id: string,
        message: { text: string; later?: unknown[] }
      ) => {
        turns.push({ text: message.text, later: message.later?.length ?? 0 })
        return { outcome: 'accepted' }
      },
      receipts: {
        run: (_k: unknown, _d: unknown, _m: unknown, _t: unknown, run: () => unknown) => run(),
        known: () => false,
        heldByMute: () => null,
        carried: async (_k: unknown, _d: unknown, _t: unknown, done: Promise<unknown>) => done
      }
    } as unknown as ExternalConversationSeam
    const machine = {
      runTrigger: async () => false,
      threadMute: (
        delivery: Parameters<typeof handleThreadMute>[1],
        record: Parameters<typeof handleThreadMute>[2]
      ) =>
        handleThreadMute(
          {
            read: () => ({ botId: 'bot1', muted }),
            write: async (_key, next) => {
              muted = next
            },
            botNames: () => ['reviewer'],
            otherBotNames: () => [],
            queued: async () => {},
            waiting: new Map(),
            react: async () => {}
          },
          delivery,
          record
        )
    }
    const batch = [
      send('<@U0BOT> ok unmute', { mentioned: true }),
      send('a'),
      send('b')
    ] as unknown as Parameters<typeof dispatchBatch>[3]
    const dispatched = dispatchBatch(
      seam,
      {} as ExternalConversationHost,
      machine,
      batch,
      () => 60_000
    )
    await Promise.all(dispatched.map((entry) => entry.done))
    expect(turns).toEqual([{ text: '<@U0BOT> ok unmute', later: 2 }])
    expect(muted).toBe(false)
  })
})

describe('a silenced reply resent after an unmute', () => {
  // Its receipt says the mute held it: the resend replays that, never reaching the chat or counting
  // its automations as run in a turn.
  it('replays as held', async () => {
    let muted = true
    const reached: string[] = []
    const held = new Map<string, Promise<unknown>>()
    const seam = {
      send: async (_host: unknown, _key: unknown, _id: string, message: { text: string }) => {
        reached.push(message.text)
        return { outcome: 'accepted' }
      },
      receipts: {
        run: (
          _k: unknown,
          id: string,
          method: string,
          _t: unknown,
          run: () => Promise<unknown>
        ) => {
          const done = run()
          if (method === 'connector.mute') {
            held.set(id, done)
          }
          return done
        },
        known: (_k: unknown, id: string) => held.has(id),
        heldByMute: (_k: unknown, id: string) => held.get(id) ?? null
      }
    } as unknown as ExternalConversationSeam
    const machine = {
      runTrigger: async () => false,
      threadMute: (
        delivery: Parameters<typeof handleThreadMute>[1],
        record: Parameters<typeof handleThreadMute>[2]
      ) =>
        handleThreadMute(
          {
            read: () => ({ botId: 'bot1', muted }),
            write: async (_key, next) => {
              muted = next
            },
            botNames: () => [],
            otherBotNames: () => [],
            queued: async () => {},
            waiting: new Map(),
            react: async () => {}
          },
          delivery,
          record
        )
    }
    const deliver = async (raw: unknown) =>
      await dispatchDelivery(seam, {} as ExternalConversationHost, machine, raw, () => 60_000)?.done
    const reply = send('do the thing', { automations: [{ automationId: 'a1', triggerId: 't1' }] })
    expect(await deliver(reply)).toEqual({ outcome: 'accepted' })
    await deliver(send('unmute'))
    expect(await deliver(reply)).toEqual({ outcome: 'accepted' })
    expect(reached).toEqual([])
    expect(muted).toBe(false)
  })
})

describe('a held reply whose thread is stopped while it waits', () => {
  // The Stop settles its wait in the thread's queue as refused: it is refused too, never sent on.
  it('is refused as the Stop refused it', async () => {
    const stopped = { outcome: 'refused', reason: 'conversation_cancelled' }
    const outcome = handleThreadMute(
      {
        read: () => null,
        write: async () => {},
        botNames: () => [],
        otherBotNames: () => [],
        queued: async () => stopped,
        waiting: new Map(),
        react: async () => {}
      },
      send('@sam be quiet') as Parameters<typeof handleThreadMute>[1],
      (handled) => handled()
    )
    expect(await outcome?.decided).toEqual(stopped)
  })
})

describe('a wait in the thread queue that a Stop lands on while it runs', () => {
  // A Stop on a running turn finds the queue busy only with the wait; the wait must still come back
  // refused, so the reply held behind it is never sent after the Stop.
  it('is refused', async () => {
    const chain = new ConversationChain(new AbortController().signal)
    let saved = (): void => {}
    const waited = chain.after('thread', () => new Promise<void>((resolve) => (saved = resolve)))
    await Promise.resolve()
    const stopped = chain.cancel('thread', 'conversation_cancelled')
    // Refused at once: the Stop never waits on a slow save.
    expect(await waited).toEqual({ outcome: 'refused', reason: 'conversation_cancelled' })
    await stopped
    saved()
  })
})
