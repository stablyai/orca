import { describe, expect, it } from 'vitest'
import { PUSH_PROMPT_DECISION_CATEGORY } from '@orca-cloud/push-contract/send-messages'
import { apnsBody } from './apns-client.js'
import type { PushDelivery } from '../../delivery/push-delivery-message.js'

function delivery(promptReply?: { allow: string; deny: string }): PushDelivery {
  return {
    expiresAt: 1,
    registrationId: 'reg',
    hostFingerprint: 'fingerprint',
    title: 'Needs you',
    body: 'Allow?',
    collapseId: 'collapse',
    orca: {
      hostFingerprint: 'fingerprint',
      notificationSeq: 1,
      notificationEpoch: 'epoch',
      source: 'agent-task-complete',
      agentState: 'needs-input',
      ...(promptReply ? { promptReply } : {})
    }
  }
}

describe('apnsBody prompt category', () => {
  it('sets the decision category only when the alert carries a reply', () => {
    const withReply = JSON.parse(apnsBody(delivery({ allow: '1', deny: '\u001b' })))
    expect(withReply.aps.category).toBe(PUSH_PROMPT_DECISION_CATEGORY)
    const withoutReply = JSON.parse(apnsBody(delivery()))
    expect(withoutReply.aps.category).toBeUndefined()
    const badge = delivery()
    badge.orca = { ...badge.orca, kind: 'badge' }
    badge.badge = 2
    expect(JSON.parse(apnsBody(badge))).toEqual({ aps: { badge: 2 } })
  })
})
