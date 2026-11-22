import { expect, it } from 'vitest'
import { BotSchema } from '../../shared/bot-types'
import {
  readConnectorMessageAsker,
  storedConnectorAsker
} from '../../shared/connector-message-asker'
import { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { botConversations } from '../bots/bot-conversations'
import { bindSlackRequester } from '../external-conversations/external-conversation-bots'
import { storedMessageBody } from '../native-chat/agent-session-journal/durable-rows/journal-storage-schema'
import { connectorDeliveryUnits } from './connector-delivery-batches'

const requester = { teamId: 'T123', userId: 'U123' }
const directAsker = {
  userId: 'U123',
  role: 'member',
  place: { kind: 'public_channel', id: 'C123' },
  text: 'Remember that I prefer examples',
  context: [],
  messageRef: 'slack:T123:C123:100.001:100.002',
  slackRequester: requester
}
const bot = BotSchema.parse({
  id: 'bot',
  name: 'Bot',
  hostId: LOCAL_EXECUTION_HOST_ID,
  folder: 'bot',
  folderWorkspaceId: 'home',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
  members: [],
  slack: { teamId: 'T123', appId: 'A123' },
  slackApps: [
    { teamId: 'T123', appId: 'A123' },
    { teamId: 'T456', appId: 'A456' }
  ],
  createdAt: 1,
  updatedAt: 1
})
const bots = botConversations({
  bots: { enabled: () => true, list: () => [bot] },
  ensureChat: async () => 'home-chat',
  startSession: async () => 'thread-chat',
  botWork: { pullRequests: async () => [] }
})

function send(
  id: string,
  asker: Record<string, unknown>,
  options: { source?: string; thread?: string } = {}
) {
  return {
    kind: 'send',
    deliveryId: id,
    expiresAt: 1,
    conversation: {
      source: options.source ?? 'slack',
      externalId: options.thread ?? 'opaque-thread'
    },
    text: directAsker.text,
    asker
  }
}

function roundTrip(raw: unknown) {
  const delivery = ConnectorDelivery.parse(raw)
  if ((delivery.kind !== 'send' && delivery.kind !== 'start') || !delivery.asker) {
    throw new Error('Expected a delivery with an asker')
  }
  const { asker, text } = bindSlackRequester(
    bots,
    delivery.conversation,
    { kind: 'bot', botId: bot.id },
    { text: delivery.asker.text, asker: delivery.asker }
  )
  const saved = storedMessageBody.parse({
    kind: 'message',
    role: 'user',
    origin: 'connector',
    blocks: [{ type: 'text', text }],
    asker: storedConnectorAsker(delivery.conversation.source, asker)
  })
  return readConnectorMessageAsker(JSON.parse(JSON.stringify(saved)).asker)
}

it('keeps the authenticated requester in durable message metadata across separate threads', () => {
  expect(
    roundTrip({
      ...send('one', directAsker),
      kind: 'start',
      agent: 'codex',
      placeId: 'bot',
      prompt: directAsker.text
    })?.slackRequester
  ).toEqual({ teamId: 'T123', userId: 'U123' })
  expect(roundTrip(send('two', directAsker, { thread: 'another-thread' }))?.slackRequester).toEqual(
    { teamId: 'T123', userId: 'U123' }
  )
})

it('accepts the bot’s other bound workspace and drops an unbound one', () => {
  expect(
    roundTrip(send('one', { ...directAsker, slackRequester: { teamId: 'T456', userId: 'U123' } }))
      ?.slackRequester
  ).toEqual({ teamId: 'T456', userId: 'U123' })
  expect(
    roundTrip(send('two', { ...directAsker, slackRequester: { teamId: 'T999', userId: 'U123' } }))
      ?.slackRequester
  ).toBeUndefined()
})

it.each([
  { slackRequester: undefined, role: 'owner' },
  { slackRequester: { teamId: '', userId: 'U123' } },
  { slackRequester: { teamId: 'T123', userId: 'UOTHER' } },
  { app: true },
  { app: 'unknown-kind' },
  { via: { kind: 'bot', userId: 'UAPP', name: 'Another bot' } },
  { via: {} }
])('drops absent, contradictory or nonhuman requester stamps: %j', (fields) => {
  const asker = roundTrip(send('one', { ...directAsker, ...fields }))
  expect(asker?.userId).toBe('U123')
  expect(asker?.slackRequester).toBeUndefined()
})

it('does not carry a Slack requester from other connectors', () => {
  expect(roundTrip(send('one', directAsker, { source: 'github' }))?.slackRequester).toBeUndefined()
})

it('batches only deliveries with the same verified scope when a requester stamp is present', () => {
  const raws = [
    send('one', directAsker),
    send('two', directAsker),
    send('three', { ...directAsker, slackRequester: { teamId: 'T456', userId: 'U123' } }),
    send('four', { ...directAsker, slackRequester: undefined }),
    send('five', {
      ...directAsker,
      userId: 'UOTHER',
      slackRequester: { teamId: 'T123', userId: 'UOTHER' }
    })
  ]
  const units = connectorDeliveryUnits(raws, () => false)
  expect(
    units.flatMap((unit) =>
      'batch' in unit ? [unit.batch.map(({ deliveryId }) => deliveryId)] : []
    )
  ).toEqual([['one', 'two'], ['three'], ['four'], ['five']])
})
