import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseDingTalkSetup,
  schemas,
  stableDeliveryId,
  stableExternalId,
  stableReplyId,
  stableSendUuid,
  type DingTalkInbound,
  type InboxRow
} from './dingtalk-domain'
import { decideInbound } from './dingtalk-inbound'
import { DingTalkLedger } from './dingtalk-ledger'
import { reconcileLedger } from './dingtalk-reconcile'
import { attributeTurnEnded } from './dingtalk-turns'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'

const profile = schemas.Profile.parse('corp:user')
const groupId = schemas.GroupId.parse('group-1')
const conversationId = schemas.ConversationId.parse('group-1')
const messageId = schemas.MessageId.parse('message-1')
const externalId = stableExternalId(profile, conversationId)

function inbound(content = '/tsbot inspect'): DingTalkInbound {
  return {
    profile,
    source: 'at',
    groupId,
    conversationId,
    messageId,
    senderOpenId: 'sender-1',
    senderName: 'Sam',
    content,
    createTime: '2026-11-21 10:00:00'
  }
}

function inbox(state: InboxRow['state'] = 'pending'): InboxRow {
  return {
    key: 'inbox-1',
    event: inbound(),
    externalId,
    body: 'inspect',
    state,
    deliveryId: stableDeliveryId(profile, messageId),
    reason: '',
    updatedAt: 1
  }
}

describe('DingTalk local domain', () => {
  it('parses setup and rejects duplicate group bindings', () => {
    expect(() =>
      parseDingTalkSetup(
        {
          groups: [
            { profile: 'corp:user', groupId: 'group-1', botId: 'bot' },
            { profile: 'corp:user', groupId: 'group-1', botId: 'other' }
          ]
        },
        ['bot', 'other']
      )
    ).toThrow('duplicate')
    expect(
      parseDingTalkSetup({ groups: [{ profile: 'corp:user', groupId: 'group-1', botId: 'bot' }] }, [
        'bot'
      ]).groups[0]?.mode
    ).toBe('at')
  })

  it('filters own messages and accepts a prefixed message', () => {
    const setup = parseDingTalkSetup({
      groups: [{ profile: 'corp:user', groupId: 'group-1', botId: 'bot', selfOpenId: 'self' }]
    })
    expect(decideInbound(setup, { ...inbound(), senderOpenId: 'self' })).toEqual({
      kind: 'drop',
      reason: 'self_message'
    })
    expect(decideInbound(setup, inbound())).toMatchObject({
      kind: 'accept',
      body: 'inspect',
      externalId,
      deliveryId: stableDeliveryId(profile, messageId)
    })
    expect(decideInbound(setup, inbound('hello'))).toEqual({ kind: 'drop', reason: 'trigger' })
  })

  it('keeps stable conversation, delivery, reply, and send ids', () => {
    expect(stableExternalId(profile, conversationId)).toBe(
      stableExternalId(profile, conversationId)
    )
    expect(stableDeliveryId(profile, messageId)).toBe(stableDeliveryId(profile, messageId))
    const reply = stableReplyId(externalId, 3)
    expect(reply).toBe(stableReplyId(externalId, 3))
    expect(stableSendUuid(reply)).toBe(stableSendUuid(reply))
  })

  it('keeps local DingTalk conversations out of the cloud contract', () => {
    expect(cloudConversation({ source: 'dingtalk', externalId })).toBeNull()
  })
})

describe('DingTalk ledger', () => {
  it('deduplicates an inbox event and persists atomically', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dingtalk-local-')), 'ledger.json')
    const ledger = new DingTalkLedger(file)
    expect(ledger.putInbox(inbox())).toBe(true)
    expect(ledger.putInbox(inbox())).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).inbox['inbox-1'].state).toBe('pending')
  })

  it('reconciles a delivering crash back to delivery', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dingtalk-local-')), 'ledger.json')
    const ledger = new DingTalkLedger(file)
    ledger.putInbox(inbox('delivering'))
    expect(
      reconcileLedger(ledger.snapshot(), { delivering: new Set(), sending: new Set() })
    ).toEqual([{ kind: 'recover-delivering', inboxKey: 'inbox-1' }])
  })
})

describe('DingTalk turn attribution', () => {
  it('ignores ambiguous delivered rows', () => {
    const ledger = new DingTalkLedger(
      join(mkdtempSync(join(tmpdir(), 'dingtalk-local-')), 'ledger.json')
    )
    ledger.putInbox(inbox('delivered'))
    ledger.putInbox({
      ...inbox('delivered'),
      key: 'inbox-2',
      event: { ...inbound(), messageId: schemas.MessageId.parse('message-2') },
      deliveryId: stableDeliveryId(profile, schemas.MessageId.parse('message-2'))
    })
    ledger.putConversation({
      externalId,
      profile,
      groupId,
      conversationId,
      botId: 'bot',
      sessionId: 'session-1',
      latestMessageId: messageId,
      updatedAt: 1
    })
    expect(
      attributeTurnEnded(ledger.snapshot(), {
        kind: 'turn-ended',
        source: 'dingtalk',
        externalId,
        turnId: 7,
        origin: 'delivery',
        lastAssistantMessage: 'done'
      })
    ).toEqual({ kind: 'ignore', reason: 'ambiguous_inbox' })
  })

  it('creates one queued reply for one delivered turn', () => {
    const ledger = new DingTalkLedger(
      join(mkdtempSync(join(tmpdir(), 'dingtalk-local-')), 'ledger.json')
    )
    ledger.putInbox(inbox('delivered'))
    ledger.putConversation({
      externalId,
      profile,
      groupId,
      conversationId,
      botId: 'bot',
      sessionId: 'session-1',
      latestMessageId: messageId,
      updatedAt: 1
    })
    const result = attributeTurnEnded(ledger.snapshot(), {
      kind: 'turn-ended',
      source: 'dingtalk',
      externalId,
      turnId: 7,
      origin: 'delivery',
      lastAssistantMessage: 'done'
    })
    expect(result.kind).toBe('reply')
    if (result.kind === 'reply') {
      expect(result.reply).toMatchObject({
        state: 'queued',
        text: 'done',
        uuid: expect.stringContaining('dt-local-')
      })
    }
  })
})

describe('DingTalk ledger durability', () => {
  const tempDir = (): string => mkdtempSync(join(tmpdir(), 'dingtalk-ledger-'))

  it('keeps memory unchanged when a write fails, so the same row can be retried', () => {
    const root = tempDir()
    const blocker = join(root, 'dir')
    const ledger = new DingTalkLedger(join(blocker, 'ledger.json'))
    writeFileSync(blocker, 'not a directory')
    expect(() => ledger.putInbox(inbox())).toThrow()
    expect(ledger.snapshot().inbox).toEqual({})
    rmSync(blocker)
    expect(ledger.putInbox(inbox())).toBe(true)
    expect(ledger.putInbox(inbox())).toBe(false)
    expect(new DingTalkLedger(join(blocker, 'ledger.json')).snapshot().inbox['inbox-1']).toEqual(
      inbox()
    )
  })

  it('refuses to overwrite an unreadable ledger', () => {
    const path = join(tempDir(), 'ledger.json')
    writeFileSync(path, '{ not json')
    const ledger = new DingTalkLedger(path)
    expect(ledger.readError).not.toBeNull()
    expect(() => ledger.putInbox(inbox())).toThrow('unreadable')
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('rejects a ledger whose rows are incomplete', () => {
    const path = join(tempDir(), 'ledger.json')
    const { event: _event, ...partial } = inbox()
    const bytes = JSON.stringify({
      version: 1,
      inbox: { 'inbox-1': partial },
      conversations: {},
      replies: {},
      watermarks: {}
    })
    writeFileSync(path, bytes)
    const ledger = new DingTalkLedger(path)
    expect(ledger.readError).not.toBeNull()
    expect(() => ledger.setWatermark('w', '1')).toThrow('unreadable')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
})
