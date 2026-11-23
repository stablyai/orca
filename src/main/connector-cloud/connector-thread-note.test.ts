import { describe, expect, it, vi } from 'vitest'
import {
  ConnectorDelivery,
  type ConnectorAsker
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { dispatchDelivery } from './connector-deliveries'

const EXPIRES_AT = 2_000_000_000_000
// Tagged partway through a thread whose earlier posts were all an app's: what was read of the
// thread came back empty, with no sign it was a thread at all.
const THREAD = 'slack:T0TEAM:C0FEED:1700000000.000100'
const READ = `orca slack read ${THREAD}`
// What a bot can run as told: the thread, a big page at a time.
const BOUNDED_READ = `${READ} --limit 100`
const conversation = {
  source: 'slack' as const,
  externalId: 'T0TEAM:C0FEED:1700000000.000100:U0BOT'
}
const botPlace = Buffer.from(JSON.stringify(['bot', 'bot-1'])).toString('base64url')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads the host.
const host = {} as ExternalConversationHost
const ASKER: ConnectorAsker = {
  userId: 'U0DANA',
  name: 'Dana',
  role: 'owner',
  place: { kind: 'channel', id: 'C0FEED' },
  text: 'look into this',
  context: [],
  messageRef: `${THREAD}:1700000500.000200`
}

async function noteOf(
  kind: 'start' | 'send',
  asker: ConnectorAsker,
  bareMention = false
): Promise<string | undefined> {
  // What the seam was handed: a start's input or a send's message, both carrying Orca's note.
  type Handed = { note?: string }
  const start = vi.fn(async (_host: unknown, _key: unknown, _id: string, _input: Handed) => ({
    conversation: { worktreeId: 'w', sessionId: 's' },
    initial: { outcome: 'accepted' as const }
  }))
  const send = vi.fn(async (_host: unknown, _key: unknown, _id: string, _message: Handed) => ({
    outcome: 'accepted' as const
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch calls only start and send here.
  const seam = { start, send } as unknown as ExternalConversationSeam
  const shared = { deliveryId: 'd1', expiresAt: EXPIRES_AT, conversation, asker }
  const delivery = ConnectorDelivery.parse(
    kind === 'start'
      ? {
          ...shared,
          kind,
          agent: 'claude',
          placeId: botPlace,
          prompt: asker.text,
          ...(bareMention ? { bareMention } : {})
        }
      : { ...shared, kind, text: asker.text }
  )
  await dispatchDelivery(seam, host, { runTrigger: async () => false }, delivery, () => 60_000)
    ?.done
  const call = (kind === 'start' ? start : send).mock.calls[0]
  return call?.[3].note
}

const count = (note: string | undefined, command: string) => (note ?? '').split(command).length - 1

describe('a chat started by a reply partway through a Slack thread', () => {
  it('names the thread to read only on a chat started by a thread reply', async () => {
    expect(count(await noteOf('start', ASKER), BOUNDED_READ)).toBe(1)
    const given: ConnectorAsker = {
      ...ASKER,
      context: [{ kind: 'bot', name: 'Forms', text: 'New form entry' }]
    }
    expect(count(await noteOf('start', given), BOUNDED_READ)).toBe(1)
    // Not on a running chat, a bare mention, a top-level post, a DM, or a message with no ref.
    expect(await noteOf('send', ASKER)).toBeUndefined()
    expect(count(await noteOf('start', ASKER, true), READ)).toBe(0)
    const topLevel = { ...ASKER, messageRef: `${THREAD}:1700000000.000100` }
    const direct = { ...ASKER, messageRef: 'slack:T0TEAM:D0DM:D0DM:1700000500.000200' }
    for (const asker of [topLevel, direct, { ...ASKER, messageRef: undefined }]) {
      expect(await noteOf('start', asker)).toBeUndefined()
    }
  })

  it('bounds the read the `more` line names without naming it twice', async () => {
    const note = await noteOf('start', { ...ASKER, context: [{ kind: 'more' }] })
    expect(note).toContain('--limit 100')
    expect(count(note, READ)).toBe(0)
  })
})
