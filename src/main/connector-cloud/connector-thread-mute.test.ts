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
  it('reads only a whole message as a command, past mentions of the bot', () => {
    expect(threadMuteCommand('mute')).toBe('mute')
    expect(threadMuteCommand('<@U0BOT> Be quiet!')).toBe('mute')
    expect(threadMuteCommand('@Orca reviewer stop responding in this thread', ['reviewer'])).toBe(
      'mute'
    )
    expect(threadMuteCommand('@Orca please unmute 🔊')).toBe('unmute')
    expect(threadMuteCommand('Start responding again.')).toBe('unmute')
    expect(threadMuteCommand("don't mute")).toBeNull()
    expect(threadMuteCommand('mute the video player')).toBeNull()
    expect(threadMuteCommand('can you stop responding so fast')).toBeNull()
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
            botNames: () => [],
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
    expect(await deliver(send('@bot mute'))).toEqual({ outcome: 'accepted' })
    await deliver(send('anyone there?'))
    await deliver(send('hello again', { mentioned: true }))
    await deliver(send('mute'))
    await deliver(send('still muted'))
    await deliver(send('unmute'))
    await deliver(send('back'))

    expect(reached).toEqual(['first', 'hello again', 'back'])
    expect(reacted).toEqual([':mute:', ':mute:', ':loud_sound:'])
    expect(muted).toBe(false)
  })
})
