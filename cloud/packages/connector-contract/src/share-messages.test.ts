import { describe, expect, it } from 'vitest'
import { canAskBot } from './bot-askers.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorDeliverySchema } from './delivery-messages.js'
import { ConnectorHelloRequestSchema } from './hello-messages.js'

const hello = {
  v: 1,
  contract: 1,
  orcaVersion: '1.4.230',
  platform: 'darwin',
  runtime: 'desktop',
  hostName: 'mac',
  promptKinds: [],
  features: ['trigger'],
  sources: ['slack']
}
const bot = { id: 'bot-1', name: 'Reviewer', agent: 'claude', members: [], paused: false }
const longEmail = (index: number) =>
  `${String(index).padStart(3, '0')}${'a'.repeat(CONNECTOR_LIMITS.maxShareEmailLength - 15)}@example.com`

describe('bot shares contract', () => {
  it('keeps a full sharedWith inside its size budget, and refuses one past it', () => {
    const sharedWith = Array.from({ length: CONNECTOR_LIMITS.maxBotShares }, (_, index) => ({
      shareId: `share-${index}`.padEnd(128, 'x'),
      email: longEmail(index)
    }))
    expect(longEmail(0)).toHaveLength(CONNECTOR_LIMITS.maxShareEmailLength)
    expect(ConnectorHelloRequestSchema.safeParse({ ...hello, bots: [{ ...bot, sharedWith }] }).success).toBe(true)
    // The app's per-bot share of a hello is about 38 KB (BOT_HELLO_BUDGET_BYTES).
    expect(Buffer.byteLength(JSON.stringify(sharedWith))).toBeLessThan(24 * 1024)
    const over = [...sharedWith, { shareId: 'one-more', accountId: 'acct-1' }]
    expect(ConnectorHelloRequestSchema.safeParse({ ...hello, bots: [{ ...bot, sharedWith: over }] }).success).toBe(false)
  })

  it('takes the owner name only within the display length', () => {
    const named = (ownerName: string) => ConnectorHelloRequestSchema.safeParse({ ...hello, ownerName }).success
    expect(named('Jinwoo Hong')).toBe(true)
    expect(named('x'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength + 1))).toBe(false)
  })

  it('takes invites only as normalized emails', () => {
    const invite = (email: string) =>
      ConnectorHelloRequestSchema.safeParse({ ...hello, bots: [{ ...bot, sharedWith: [{ shareId: 's1', email }] }] })
        .success
    expect(invite('alice@stably.ai')).toBe(true)
    expect(invite('Alice@stably.ai')).toBe(false)
    expect(invite(' alice@stably.ai')).toBe(false)
    for (const malformed of ['a@@b.co', '@ab.co', 'ab@']) {
      expect(invite(malformed)).toBe(false)
    }
  })

  it('never reads orca as a place: no workspace rows, no rules, only share deliveries on it', () => {
    const parsed = ConnectorHelloRequestSchema.parse({
      ...hello,
      bots: [{ ...bot, sharedAppWorkspaces: [{ source: 'orca', workspaceId: 'w', members: [] }] }]
    })
    expect(parsed.bots?.[0]?.sharedAppWorkspaces).toEqual([])
    const rule = { id: 't1', automationId: 'a1', botId: 'bot-1', source: 'orca', event: 'x', graceMinutes: 60 }
    expect(ConnectorHelloRequestSchema.parse({ ...hello, triggers: [rule] }).triggers).toEqual([])

    const base = { deliveryId: 'd1', seq: 1, expiresAt: 1, shareId: 's1', botId: 'bot-1' }
    const resolved = { ...base, kind: 'share_resolved', email: 'alice@stably.ai', accountId: 'acct-1' }
    const onShare = { source: 'orca', externalId: 's1' }
    expect(ConnectorDeliverySchema.safeParse({ ...resolved, conversation: onShare }).success).toBe(true)
    // Another share's queue would let it pass that share's accept.
    expect(
      ConnectorDeliverySchema.safeParse({ ...resolved, conversation: { ...onShare, externalId: 's2' } })
        .success
    ).toBe(false)
    expect(
      ConnectorDeliverySchema.safeParse({ ...resolved, conversation: { source: 'slack', externalId: 's1' } }).success
    ).toBe(false)
    expect(
      ConnectorDeliverySchema.safeParse({
        ...base,
        kind: 'start',
        conversation: onShare,
        agent: 'claude',
        placeId: 'p',
        prompt: 'hi'
      }).success
    ).toBe(false)
  })

  it('lets a person ask through any linked account the bot is shared with', () => {
    const shared = { ownerUserId: 'U0OWNER', members: ['U0MEMBER'], sharedAccountIds: ['acct-2'] }
    expect(canAskBot(shared, 'U0ALICE', ['acct-1', 'acct-2'])).toBe(true)
    expect(canAskBot(shared, 'U0ALICE', ['acct-1'])).toBe(false)
    expect(canAskBot(shared, 'U0ALICE', [])).toBe(false)
    expect(canAskBot({ ownerUserId: 'U0OWNER', members: [] }, 'U0ALICE', ['acct-2'])).toBe(false)
    expect(canAskBot(shared, 'U0MEMBER', [])).toBe(true)
  })
})
