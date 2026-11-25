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
const turn = (
  source: 'feishu' | 'lark' | 'slack',
  turnId: number
): Extract<ConversationEvent, { kind: 'turn-ended' }> => ({
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
const ended = () => h.fake.events.filter(isRecord).filter((event) => event.kind === 'turn-ended')

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

  it.each([
    {
      source: 'feishu',
      recordedPaused: false,
      receivingPaused: true,
      expectedResumes: [true, true]
    },
    {
      source: 'lark',
      recordedPaused: true,
      receivingPaused: false,
      expectedResumes: [undefined, undefined]
    }
  ] as const)(
    'replays held $source pause status for the receiving Cloud while Slack continues',
    async ({ source, recordedPaused, receivingPaused, expectedResumes }) => {
      const pausedTurn = (turnId: number): ConversationEvent => ({
        ...turn(source, turnId),
        stopReason: 'failure',
        lastAssistantMessage: undefined,
        stateOnly: true,
        resumes: true,
        failure: { category: 'usage_limit', usageLimit: { resetsAt: SERVER_NOW + 60_000 } }
      })
      h.fake.features = [
        `${source}.mentions`,
        'replies.outbox',
        ...(recordedPaused ? ['replies.paused'] : [])
      ]
      h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
      const first = h.startClient()
      await settle()
      first.emit(pausedTurn(21))
      await settle()
      await ConnectorTurnEvents.settled()
      first.client.stop()

      h.fake.features = []
      h.fake.eventSources = ['slack', 'linear', 'github', 'discord', 'webhook']
      h.fake.forced.delete(CONNECTOR_PATHS.events)
      const oldCloud = h.startClient()
      await settle()
      oldCloud.emit(turn('slack', 22))
      oldCloud.emit(pausedTurn(23))
      await settle(100)
      expect(ended()).toMatchObject([{ conversation: { source: 'slack' }, turnId: 22 }])
      await ConnectorTurnEvents.settled()
      const stored = JSON.parse(
        readFileSync(join(h.userDataPath, 'connector-turn-outbox.json'), 'utf8')
      )
      expect(stored.turnEnds).toMatchObject([
        { conversation: { source, externalId: 'app:tenant:chat:root' }, turnId: 21 },
        { conversation: { source, externalId: 'app:tenant:chat:root' }, turnId: 23 }
      ])
      oldCloud.client.stop()

      h.fake.features = [
        `${source}.mentions`,
        'replies.outbox',
        ...(receivingPaused ? ['replies.paused'] : [])
      ]
      h.fake.eventSources = undefined
      const upgraded = h.startClient()
      try {
        await settle(100)
        expect(ended()).toMatchObject([
          { conversation: { source: 'slack' }, turnId: 22 },
          {
            conversation: { source, externalId: 'app:tenant:chat:root' },
            turnId: 21,
            stateOnly: true,
            failure: { category: 'usage_limit', usageLimit: { resetsAt: 1800000060000 } }
          },
          {
            conversation: { source, externalId: 'app:tenant:chat:root' },
            turnId: 23,
            stateOnly: true,
            failure: { category: 'usage_limit', usageLimit: { resetsAt: 1800000060000 } }
          }
        ])
        expect(
          ended()
            .slice(1)
            .map((event) => event.resumes)
        ).toEqual(expectedResumes)
        await ConnectorTurnEvents.settled()
        expect(existsSync(join(h.userDataPath, 'connector-turn-outbox.json'))).toBe(false)
      } finally {
        upgraded.client.stop()
      }
    }
  )
})
