import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import {
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'

const h = pollClientHarness()
const turn = (source: 'feishu' | 'lark' | 'slack', turnId: number): ConversationEvent => ({
  kind: 'turn-ended',
  conversation: { source, externalId: 'app:tenant:chat:root' },
  worktreeId: 'workspace',
  paneKey: `${source}-pane`,
  turnId,
  at: SERVER_NOW,
  stopReason: 'success',
  lastAssistantMessage: 'Finished work.',
  origin: 'delivery'
})
const ended = () => h.fake.events.filter((event) => isRecord(event) && event.kind === 'turn-ended')

// Real durable event file and client; fake Cloud with the older deployment's source restriction.
describe('new-source turn ends across capability negotiation', () => {
  it('keeps a pre-hello Feishu turn end through a restart and sends it after negotiation', async () => {
    new ConnectorTurnEvents(h.userDataPath, 'ada').observe(turn('feishu', 11))
    await ConnectorTurnEvents.settled()
    h.fake.features = ['feishu.mentions', 'replies.outbox']
    const { client } = h.startClient()
    try {
      await settle(100)
      expect(ended()).toEqual([
        {
          kind: 'turn-ended',
          conversation: { source: 'feishu', externalId: 'app:tenant:chat:root' },
          paneKey: 'feishu-pane',
          turnId: 11,
          at: 1800000000000,
          stopReason: 'success',
          lastAssistantMessage: 'Finished work.',
          origin: 'delivery'
        }
      ])
      await ConnectorTurnEvents.settled()
      expect(existsSync(join(h.userDataPath, 'connector-turn-outbox.json'))).toBe(false)
    } finally {
      client.stop()
    }
  })

  it('retains old and newly observed Lark turn ends while an older Cloud still receives Slack', async () => {
    h.fake.features = ['lark.mentions', 'replies.outbox']
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const first = h.startClient()
    await settle()
    first.emit(turn('lark', 21))
    await settle()
    await ConnectorTurnEvents.settled()
    first.client.stop()

    h.fake.features = []
    h.fake.eventSources = ['slack', 'linear', 'github', 'discord', 'webhook']
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    const oldCloud = h.startClient()
    await settle()
    oldCloud.emit(turn('slack', 22))
    oldCloud.emit(turn('lark', 23))
    await settle(100)
    expect(ended()).toMatchObject([{ conversation: { source: 'slack' }, turnId: 22 }])
    await ConnectorTurnEvents.settled()
    const stored = JSON.parse(
      readFileSync(join(h.userDataPath, 'connector-turn-outbox.json'), 'utf8')
    )
    expect(stored.turnEnds).toMatchObject([
      { conversation: { source: 'lark', externalId: 'app:tenant:chat:root' }, turnId: 21 },
      { conversation: { source: 'lark', externalId: 'app:tenant:chat:root' }, turnId: 23 }
    ])
    oldCloud.client.stop()

    h.fake.features = ['lark.mentions', 'replies.outbox']
    h.fake.eventSources = undefined
    const upgraded = h.startClient()
    try {
      await settle(100)
      expect(ended()).toMatchObject([
        { conversation: { source: 'slack' }, turnId: 22 },
        {
          conversation: { source: 'lark', externalId: 'app:tenant:chat:root' },
          turnId: 21,
          lastAssistantMessage: 'Finished work.'
        },
        {
          conversation: { source: 'lark', externalId: 'app:tenant:chat:root' },
          turnId: 23,
          lastAssistantMessage: 'Finished work.'
        }
      ])
      await ConnectorTurnEvents.settled()
      expect(existsSync(join(h.userDataPath, 'connector-turn-outbox.json'))).toBe(false)
    } finally {
      upgraded.client.stop()
    }
  })
})
