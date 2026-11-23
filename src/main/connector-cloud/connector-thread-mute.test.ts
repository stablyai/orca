import { describe, expect, it } from 'vitest'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { dispatchDelivery } from './connector-deliveries'
import { handleThreadMute, threadMuteCommand } from './connector-thread-mute'

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
    // Someone else's mute, a question, or a sentence that only contains the word.
    expect(threadMuteCommand('<@UOTHER> mute', bot)).toBeNull()
    expect(threadMuteCommand('@bob be quiet', bot)).toBeNull()
    expect(threadMuteCommand('mute?', bot)).toBeNull()
    expect(threadMuteCommand("don't mute", bot)).toBeNull()
    expect(threadMuteCommand('mute the video player', bot)).toBeNull()
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
        run: (_k: unknown, _d: unknown, _m: unknown, _t: unknown, run: () => unknown) => run()
      }
    } as unknown as ExternalConversationSeam
    const machine = {
      runTrigger: async () => false,
      threadMute: (delivery: Parameters<typeof handleThreadMute>[1]) =>
        handleThreadMute(
          {
            read: () => ({ botId: 'bot1', muted }),
            write: (_key, next) => {
              muted = next
            },
            botNames: () => ['reviewer'],
            queued: async () => {},
            react: async (_bot, _key, _ref, emoji) => {
              reacted.push(emoji)
            }
          },
          delivery
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
    await deliver(send('still muted'))
    await deliver(send('unmute'))
    await deliver(send('back'))

    expect(reached).toEqual(['first', 'hello again', 'ping @reviewer', 'back'])
    expect(reacted).toEqual([':mute:', ':mute:', ':mute:', ':loud_sound:'])
    expect(muted).toBe(false)
  })
})

describe('a mute in the same poll as its thread’s start', () => {
  // The start writes the thread's link only once its queued delivery runs; the mute must wait for it.
  it('mutes once the queued start linked the thread', async () => {
    let linked = false
    let muted = false
    const done = handleThreadMute(
      {
        read: () => (linked ? { botId: 'bot1', muted } : null),
        write: (_key, next) => {
          muted = next
        },
        botNames: () => [],
        queued: async () => {
          linked = true
        },
        react: async () => {}
      },
      send('mute') as Parameters<typeof handleThreadMute>[1]
    )
    expect(await done).toEqual({ outcome: 'accepted' })
    expect(muted).toBe(true)
  })
})
