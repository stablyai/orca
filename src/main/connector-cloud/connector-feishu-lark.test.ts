import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  attach,
  hostTestState
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { chatPaneKey } from '../external-conversations/external-conversation-chat'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { findLink } from '../external-conversations/external-conversation-links'
import { finishTurn } from '../external-conversations/external-conversation-provider-turn.test-fixture'
import { conversationReplyFill } from '../external-conversations/external-conversation-reply-fill'
import { harness } from '../external-conversations/external-conversation-seam.test-fixture'
import { ConnectorPollClient } from './connector-poll-client'
import { pollClientHarness, SERVER_NOW, settle } from './connector-poll-client.test-fixture'
import { ConnectorAccountTransport } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { fakeMachine } from './fake-connector-seam.test-fixture'

// Mock hosted service and agent provider; real poll client, admission, journal, links and reply outbox.
const h = pollClientHarness()
const HOME = folderWorkspaceKey('review-bot-home')
const PANE = chatPaneKey(HOST_TEST_SESSION)
const opened: { client: ConnectorPollClient; local: ReturnType<typeof harness> }[] = []

afterEach(() => {
  for (const { client, local } of opened.splice(0)) {
    client.stop()
    local.seam.dispose('connectors_disabled')
    local.db.close()
  }
})

async function startHost() {
  const { host, store } = hostTestState()
  await attach()
  const journal = store.connectorReplies()
  const events = new ConnectorTurnEvents(h.userDataPath, 'ada', undefined, {
    journal: () => journal,
    onOwed: () => {},
    post: async () => {
      throw new Error('this fixture uses reply events')
    },
    hostName: () => 'box'
  })
  const fill = conversationReplyFill(
    () => journal,
    () => void events.drainReplies()
  )
  const local = harness(undefined, undefined, { replyFill: () => fill })
  local.folders.push({ id: 'review-bot-home' })
  const conversationHost: ExternalConversationHost = {
    chat: { current: () => host, ensure: async () => host, onChanged: () => () => {} },
    bots: {
      refusal: (botId) => (botId === 'review-bot' ? null : 'bot_not_found'),
      open: async () => ({ worktreeId: HOME, sessionId: HOST_TEST_SESSION, agent: 'codex' }),
      workLinks: async () => []
    }
  }
  const machine = fakeMachine(() => null)
  machine.seam = () => local.seam
  machine.conversationHost = () => conversationHost
  machine.botList = [
    { id: 'review-bot', name: 'Reviewer', agent: 'codex', members: [], paused: false }
  ]
  const client = new ConnectorPollClient({
    transport: new ConnectorAccountTransport(h.fake.origin, h.fake.mintFor('ada'), h.fake.fetch),
    events,
    seam: local.seam,
    machine,
    random: () => 0.5
  })
  opened.push({ client, local })
  client.start()
  await settle()
  return { client, local, journal, host }
}

const mention = (conversation: ConnectorConversation) => ({
  seq: 1,
  deliveryId: 'mention-1',
  expiresAt: SERVER_NOW + 300_000,
  conversation,
  kind: 'start',
  agent: 'codex',
  // ['bot', 'review-bot'], the existing bot place encoding.
  placeId: 'WyJib3QiLCJyZXZpZXctYm90Il0',
  prompt: 'Review the deployment',
  asker: {
    userId: 'ou_authorised',
    name: 'Dana',
    role: 'member',
    place: { kind: 'channel', id: 'oc_reviews' },
    text: 'Review the deployment',
    context: []
  }
})

function running(local: ReturnType<typeof harness>) {
  const at = SERVER_NOW + 1
  local.hookRows.set(PANE, {
    paneKey: PANE,
    tabId: 'tab',
    worktreeId: HOME,
    connectionId: null,
    structuredHost: 'owned',
    state: 'working',
    prompt: 'Review the deployment',
    agentType: 'codex',
    receivedAt: at,
    stateStartedAt: at
  })
  local.paneChange({
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: HOME, sshHostId: null },
    from: 'rest',
    to: 'working',
    at,
    transition: 'prompt-submitted'
  })
}

describe('hosted group mentions (mock Cloud)', () => {
  it.each([
    {
      source: 'feishu',
      feature: 'feishu.mentions',
      sources: ['slack', 'linear', 'github', 'feishu']
    },
    { source: 'lark', feature: 'lark.mentions', sources: ['slack', 'linear', 'github', 'lark'] }
  ] as const)(
    'delivers $source to its bot and replies to the same app, tenant and thread',
    async ({ source, feature, sources }) => {
      h.fake.features = [feature, 'replies.outbox']
      const { local, journal, host } = await startHost()
      expect(h.fake.hellos[0]).toMatchObject({ sources: ['slack', 'linear', 'github'] })
      expect(h.fake.hellos.at(-1)).toMatchObject({ sources })
      const conversation = { source, externalId: 'cli_app_a:tenant_a:oc_reviews:om_root' }
      const delivery = mention(conversation)
      h.poll([delivery])
      await eventually(async () => {
        await settle()
        expect(h.fake.acks).toContainEqual({
          deliveryId: 'mention-1',
          step: 'done',
          result: { outcome: 'accepted' }
        })
      })
      expect(findLink(local.store, conversation)?.link).toMatchObject({
        source,
        externalId: 'cli_app_a:tenant_a:oc_reviews:om_root',
        bot: { kind: 'bot', botId: 'review-bot' },
        sessionId: 'session-alpha'
      })
      expect(await journal.read()).toMatchObject([
        {
          account: 'ada',
          deliveryId: 'mention-1',
          conversation,
          sessionId: 'session-alpha'
        }
      ])
      // A redelivered Cloud delivery keeps its original admission and one journal message.
      h.poll([delivery])
      await settle()
      const history = await host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      expect(
        history.ok &&
          history.page.items.flatMap((item) =>
            item.body.kind === 'message' && item.body.role === 'user'
              ? [item.body.connectorDelivery]
              : []
          )
      ).toEqual([{ account: 'ada', deliveryId: 'mention-1', conversation }])
      // Admission precedes handoff; the simulated completion must name the dispatched message.
      await eventually(() => expect(hostTestState().dispatch).toHaveBeenCalled())
      await finishTurn('Deployment reviewed.', {
        turnScopedReply: true,
        running: () => running(local)
      })
      await eventually(async () => {
        await settle()
        expect(h.fake.events).toContainEqual({
          kind: 'reply',
          conversation,
          deliveryIds: ['mention-1'],
          answerDeliveryId: 'mention-1',
          outcome: 'answered',
          prose: 'Deployment reviewed.'
        })
      })
      await eventually(async () => expect(await journal.read()).toEqual([]))
    }
  )

  it('does not route another app, tenant, thread or platform into an admitted Feishu chat', async () => {
    h.fake.features = ['feishu.mentions', 'lark.mentions', 'replies.outbox']
    const { local } = await startHost()
    h.poll([mention({ source: 'feishu', externalId: 'cli_app_a:tenant_a:oc_reviews:om_root' })])
    await eventually(async () => {
      await settle()
      expect(h.fake.acks).toContainEqual({
        deliveryId: 'mention-1',
        step: 'done',
        result: { outcome: 'accepted' }
      })
    })
    h.poll(
      [
        {
          deliveryId: 'other-app',
          source: 'feishu',
          externalId: 'cli_app_b:tenant_a:oc_reviews:om_root'
        },
        {
          deliveryId: 'other-tenant',
          source: 'feishu',
          externalId: 'cli_app_a:tenant_b:oc_reviews:om_root'
        },
        {
          deliveryId: 'other-thread',
          source: 'feishu',
          externalId: 'cli_app_a:tenant_a:oc_reviews:om_other'
        },
        {
          deliveryId: 'other-platform',
          source: 'lark',
          externalId: 'cli_app_a:tenant_a:oc_reviews:om_root'
        }
      ].map(({ deliveryId, source, externalId }) => ({
        deliveryId,
        conversation: { source, externalId },
        kind: 'send',
        expiresAt: SERVER_NOW + 300_000,
        text: 'This belongs elsewhere'
      }))
    )
    await eventually(async () => {
      await settle()
      expect(h.fake.acks).toEqual(
        expect.arrayContaining([
          {
            deliveryId: 'other-app',
            step: 'done',
            result: { outcome: 'refused', reason: 'external_conversation_not_found' }
          },
          {
            deliveryId: 'other-tenant',
            step: 'done',
            result: { outcome: 'refused', reason: 'external_conversation_not_found' }
          },
          {
            deliveryId: 'other-thread',
            step: 'done',
            result: { outcome: 'refused', reason: 'external_conversation_not_found' }
          },
          {
            deliveryId: 'other-platform',
            step: 'done',
            result: { outcome: 'refused', reason: 'external_conversation_not_found' }
          }
        ])
      )
    })
    expect(local.seam.replyTarget(PANE)?.key).toEqual({
      source: 'feishu',
      externalId: 'cli_app_a:tenant_a:oc_reviews:om_root'
    })
  })

  it('keeps Slack admission and replies with a Cloud that advertises neither new source', async () => {
    const { local, client } = await startHost()
    const conversation = { source: 'slack' as const, externalId: 'T1:C9:1792.9' }
    h.poll([mention(conversation)])
    await eventually(async () => {
      await settle()
      expect(h.fake.acks).toContainEqual({
        deliveryId: 'mention-1',
        step: 'done',
        result: { outcome: 'accepted' }
      })
    })
    expect(h.fake.hellos).toMatchObject([{ sources: ['slack', 'linear', 'github'] }])
    const target = local.seam.replyTarget(PANE)
    expect(target?.key).toEqual({ source: 'slack', externalId: 'T1:C9:1792.9' })
    expect(
      await client.reply({
        replyId: 'slack-answer',
        conversation: target!.key,
        turnId: SERVER_NOW,
        text: 'Reviewed.'
      })
    ).toMatchObject({ ok: true })
    expect(h.fake.replies.get('slack-answer')).toMatchObject({
      conversation: { source: 'slack', externalId: 'T1:C9:1792.9' },
      text: 'Reviewed.'
    })
  })
})
