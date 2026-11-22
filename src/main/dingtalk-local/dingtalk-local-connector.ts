import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { conversationKey } from './dingtalk-local-conversation'
import {
  readDingTalkSetup,
  schemas,
  type DingTalkGroupSetup,
  type DingTalkInbound,
  type DingTalkSetup,
  type ReplyRow
} from './dingtalk-domain'
import { decideInbound } from './dingtalk-inbound'
import { DingTalkLedger } from './dingtalk-ledger'
import { attributeTurnEnded, type TurnObservation } from './dingtalk-turns'
import { recoverDingTalkLedger, replayDingTalkInbox } from './dingtalk-local-recovery'
import { sendDingTalkReplyIfEnabled } from './dingtalk-local-reply-send'
import { statusOf, type DingTalkLocalStatus } from './dingtalk-local-status'
import { DwsBoundary, type DwsConsumer, type DwsEvent } from './dws/dingtalk-dws-boundary'

export type DingTalkLocalConnector = {
  start(): Promise<void>
  stop(): Promise<void>
  reload(): Promise<void>
  status(): DingTalkLocalStatus
}

type ConnectorDeps = {
  userDataPath: string
  configPath?: string
  seam: () => ExternalConversationSeam | null
  host: () => ExternalConversationHost
  bots: () => readonly Bot[]
}

const defaultConfigPath = (userDataPath: string): string =>
  process.env.DINGTALK_LOCAL_CONFIG?.trim() || join(userDataPath, 'dingtalk-local.json')

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function installDingTalkLocalConnector(deps: ConnectorDeps): DingTalkLocalConnector {
  const configPath = deps.configPath ?? defaultConfigPath(deps.userDataPath)
  const ledger = new DingTalkLedger(join(deps.userDataPath, 'dingtalk-local-ledger.json'))
  const dws = new DwsBoundary(() => currentSetup?.dwsPath ?? 'dws')
  let currentSetup: DingTalkSetup | null = null
  let consumers: DwsConsumer[] = []
  let releaseWatch: (() => void) | null = null
  let running = false
  // Bumped by stop() so a reload awaiting stopConsumers() does not install consumers afterwards.
  let lifecycle = 0
  let lastError = ''
  const sending = new Set<string>()
  const recordError = (error: unknown): void => {
    lastError = messageOf(error)
  }

  const readSetup = (): Promise<DingTalkSetup> =>
    readDingTalkSetup(
      configPath,
      deps.bots().map((bot) => bot.id)
    )

  const botFor = (botId: string): Bot => {
    const bot = deps.bots().find((entry) => entry.id === botId)
    if (!bot) {
      throw new Error(`DingTalk bot not found: ${botId}`)
    }
    return bot
  }

  const askerFor = (event: DingTalkInbound, body: string): ConnectorAsker => ({
    userId: event.senderOpenId,
    name: event.senderName || undefined,
    role: 'member',
    place: { kind: 'group_message', id: event.groupId },
    text: body,
    context: [],
    messageRef: `dingtalk:${event.groupId}:${event.messageId}`
  })

  const handleInbound = async (event: DingTalkInbound): Promise<void> => {
    const setup = currentSetup
    if (!setup?.enabled) {
      return
    }
    const decision = decideInbound(setup, event)
    if (decision.kind === 'drop') {
      return
    }
    const key = `${event.profile}\u0000${event.messageId}`
    const inserted = await ledger.putInbox({
      key,
      event,
      externalId: decision.externalId,
      body: decision.body,
      state: 'pending',
      deliveryId: decision.deliveryId,
      reason: '',
      updatedAt: Date.now()
    })
    if (!inserted) {
      return
    }
    const binding = decision.binding
    const conversation = decision.externalId
    await ledger.putConversation({
      externalId: conversation,
      profile: event.profile,
      groupId: event.groupId,
      conversationId: schemas.ConversationId.parse(event.conversationId),
      botId: binding.botId,
      sessionId: '',
      latestMessageId: event.messageId,
      updatedAt: Date.now()
    })
    await deliverInbox(key, binding, event, decision.body)
  }

  const deliverInbox = async (
    inboxKey: string,
    binding: DingTalkGroupSetup,
    event: DingTalkInbound,
    body: string
  ): Promise<void> => {
    const row = ledger.snapshot().inbox[inboxKey]
    if (!row || row.state !== 'pending') {
      return
    }
    // A replay and a live event can race for one pending row; the loser stops here.
    try {
      await ledger.transitionInbox(inboxKey, 'pending', 'delivering')
    } catch (error) {
      recordError(error)
      return
    }
    const seam = deps.seam()
    if (!seam) {
      await ledger.transitionInbox(inboxKey, 'delivering', 'failed', {
        reason: 'connectors_disabled'
      })
      return
    }
    const key = conversationKey(row.externalId)
    const asker = askerFor(event, body)
    const bot = botFor(binding.botId)
    try {
      const linked = seam.linkedChat(key, binding.botId)
      const result = linked
        ? await seam.send(deps.host(), key, row.deliveryId, { text: body, asker })
        : (
            await seam.start(deps.host(), key, row.deliveryId, {
              agent: bot.agent,
              target: { kind: 'bot', botId: binding.botId },
              prompt: body,
              asker
            })
          ).initial
      await (result.outcome === 'accepted'
        ? ledger.transitionInbox(inboxKey, 'delivering', 'delivered')
        : ledger.transitionInbox(inboxKey, 'delivering', 'failed', { reason: result.reason }))
    } catch (error) {
      await ledger.transitionInbox(inboxKey, 'delivering', 'failed', {
        reason: messageOf(error)
      })
    }
  }

  const handleTurn = async (
    event: Extract<
      Parameters<Parameters<ExternalConversationSeam['watch']>[1]>[0],
      { kind: 'turn-ended' }
    >
  ): Promise<void> => {
    const attribution = attributeTurnEnded(ledger.snapshot(), {
      kind: 'turn-ended',
      source: event.conversation.source,
      externalId: event.conversation.externalId,
      turnId: event.turnId,
      origin: event.origin,
      lastAssistantMessage: event.lastAssistantMessage
    } satisfies TurnObservation)
    if (attribution.kind !== 'reply') {
      return
    }
    await ledger.putReply(attribution.reply)
    const inbox = ledger.snapshot().inbox[attribution.inboxKey]
    if (inbox?.state === 'delivered') {
      await ledger.transitionInbox(attribution.inboxKey, 'delivered', 'attributed')
    }
    void sendReplyIfEnabled(attribution.reply)
  }

  const sendReplyIfEnabled = (reply: ReplyRow): Promise<void> =>
    sendDingTalkReplyIfEnabled({ ledger, dws, setup: currentSetup, sending }, reply)

  const onEvent = (event: DwsEvent): void => {
    try {
      void handleInbound({
        ...event,
        conversationId: schemas.ConversationId.parse(event.conversationId)
      }).catch(recordError)
    } catch (error) {
      recordError(error)
    }
  }

  const reload = async (): Promise<void> => {
    currentSetup = await readSetup()
    if (!running) {
      return
    }
    const generation = lifecycle
    await stopConsumers()
    if (!running || generation !== lifecycle || !currentSetup.enabled) {
      return
    }
    const byProfile = new Map<DingTalkGroupSetup['profile'], boolean>()
    for (const group of currentSetup.groups) {
      if (group.mode === 'at') {
        byProfile.set(group.profile, true)
      } else {
        consumers.push(
          dws.consume(group.profile, { kind: 'group', groupId: group.groupId }, onEvent)
        )
      }
    }
    for (const profile of byProfile.keys()) {
      consumers.push(dws.consume(profile, { kind: 'at' }, onEvent))
    }
    const setup = currentSetup
    if (setup) {
      replayDingTalkInbox(ledger, setup, async (inboxKey, binding, row) => {
        await deliverInbox(inboxKey, binding, row.event, row.body).catch(recordError)
      })
    }
  }

  const stopConsumers = async (): Promise<void> => {
    const active = consumers
    consumers = []
    await Promise.all(active.map((consumer) => consumer.stop()))
  }

  return {
    start: async () => {
      if (running) {
        return
      }
      running = true
      await ledger.load()
      if (ledger.readError) {
        running = false
        lastError = `DingTalk ledger unreadable, connector not started: ${ledger.readError}`
        throw new Error(lastError)
      }
      currentSetup = await readSetup()
      const seam = deps.seam()
      if (seam) {
        releaseWatch = seam.watch(deps.host(), (event) => {
          if (event.kind === 'turn-ended') {
            void handleTurn(event).catch(recordError)
          }
        })
      }
      await recoverDingTalkLedger(ledger, currentSetup, sendReplyIfEnabled)
      await reload()
    },
    stop: async () => {
      if (!running) {
        return
      }
      running = false
      lifecycle += 1
      releaseWatch?.()
      releaseWatch = null
      await stopConsumers()
      await dws.close()
    },
    reload,
    status: () =>
      statusOf({
        setup: currentSetup,
        configPath,
        consumerCount: consumers.length,
        ledger: ledger.snapshot(),
        lastError
      })
  }
}
