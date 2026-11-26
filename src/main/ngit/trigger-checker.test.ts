import { npubEncode } from 'nostr-tools/nip19'
import { describe, expect, it } from 'vitest'
import type { AutomationNgitTrigger } from '../../shared/automation-ngit-triggers'
import { testAuthor } from './local-nostr-relay.test-fixture'
import type { NostrRepository } from './repository-announcement'
import { NGIT_CHECK_INTERVAL_MS, NgitTriggerChecker } from './trigger-checker'
import type { NgitTriggerState } from './trigger-state'
import { projectNostrWorkItems } from './work-item-projection'

const maintainer = testAuthor(1)
const stranger = testAuthor(4)
const owner = testAuthor(5)
const url = `nostr://${npubEncode(maintainer.pubkey)}/demo`
const repository: NostrRepository = {
  identifier: 'demo',
  ownerPubkey: maintainer.pubkey,
  name: 'demo',
  maintainers: [maintainer.pubkey, owner.pubkey],
  coordinates: [],
  relays: [],
  cloneUrls: [],
  webUrl: 'https://gitworkshop.dev/demo'
}

function rule(id: string, from?: string[]): AutomationNgitTrigger {
  return { id, source: 'ngit', event: 'issue_opened', in: [url], ...(from ? { from } : {}) }
}

function automation(id: string, on: AutomationNgitTrigger) {
  const bot = { botId: 'bot', runsIn: 'new' as const, resultsTo: 'chat' as const }
  return { id, enabled: true, bot, on: [on] }
}

describe('ngit trigger checker', () => {
  it('starts once, only for the people a rule takes, and never for older events', async () => {
    const issues = [
      maintainer.sign(1621, [['subject', 'old']], '', 500),
      maintainer.sign(1621, [['subject', 'ours']], '', 2_000),
      stranger.sign(1621, [['subject', 'theirs']], '', 2_001),
      owner.sign(1621, [['subject', 'own']], '', 2_002)
    ]
    let events = issues.slice(0, 0)
    let now = 1_000_000
    let state: NgitTriggerState = { listeners: {}, handled: [] }
    const started: string[] = []
    const checker = new NgitTriggerChecker({
      automations: () => [
        automation('maintainers', rule('a')),
        automation('anyone', rule('b', ['anyone'])),
        automation('owner', rule('c', [npubEncode(owner.pubkey)]))
      ],
      read: async () => ({ repository, items: projectNostrWorkItems(repository, events) }),
      ownNpub: async () => npubEncode(owner.pubkey),
      runForEvent: async (automationId, event) => {
        started.push(`${automationId}:${event.text?.split(' ')[0]}`)
      },
      readState: async () => structuredClone(state),
      writeState: async (next) => {
        state = next
      },
      now: () => now
    })

    await checker.tick()
    events = issues
    now += NGIT_CHECK_INTERVAL_MS
    await checker.tick()
    now += NGIT_CHECK_INTERVAL_MS
    await checker.tick()

    expect(started.sort()).toEqual([
      'anyone:ours',
      'anyone:theirs',
      'maintainers:ours',
      'owner:own'
    ])
  })
})
