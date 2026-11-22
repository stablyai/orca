import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { conversationKey } from './dingtalk-local-conversation'
import {
  parseDingTalkSetup,
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

  const readSetup = (): DingTalkSetup => {
    const raw: unknown = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf8'))
      : { enabled: false }
    return parseDingTalkSetup(
      raw,
      deps.bots().map((bot) => bot.id)
    )
  }

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
    const inserted = ledger.putInbox({
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
    ledger.putConversation({
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
    ledger.transitionInbox(inboxKey, 'pending', 'delivering')
    const seam = deps.seam()
    if (!seam) {
      ledger.transitionInbox(inboxKey, 'delivering', 'failed', { reason: 'connectors_disabled' })
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
      if (result.outcome === 'accepted') {
        ledger.transitionInbox(inboxKey, 'delivering', 'delivered')
      } else {
        ledger.transitionInbox(inboxKey, 'delivering', 'failed', { reason: result.reason })
      }
    } catch (error) {
      ledger.transitionInbox(inboxKey, 'delivering', 'failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const handleTurn = (
    event: Extract<
      Parameters<Parameters<ExternalConversationSeam['watch']>[1]>[0],
      { kind: 'turn-ended' }
    >
  ): void => {
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
    ledger.putReply(attribution.reply)
    const inbox = ledger.snapshot().inbox[attribution.inboxKey]
    if (inbox?.state === 'delivered') {
      ledger.transitionInbox(attribution.inboxKey, 'delivered', 'attributed')
    }
    void sendReplyIfEnabled(attribution.reply)
  }

  const sendReplyIfEnabled = async (reply: ReplyRow): Promise<void> => {
    const setup = currentSetup
    if (!setup?.enabled || sending.has(reply.key)) {
      return
    }
    const binding = setup.groups.find(
      (group) => group.profile === reply.profile && group.groupId === reply.groupId
    )
    if (!binding || !setup.autoReply) {
      return
    }
    sending.add(reply.key)
    try {
      ledger.transitionReply(reply.key, 'queued', 'sending')
      const outcome = await dws.send(reply.profile, reply.groupId, reply.text, reply.uuid)
      if (outcome.kind === 'sent') {
        ledger.transitionReply(reply.key, 'sending', 'sent')
      } else if (outcome.kind === 'not-started') {
        ledger.transitionReply(reply.key, 'sending', 'failed', { error: outcome.error })
      } else {
        ledger.transitionReply(reply.key, 'sending', 'uncertain', { error: outcome.error })
      }
    } catch (error) {
      const row = ledger.snapshot().replies[reply.key]
      if (row?.state === 'sending') {
        ledger.transitionReply(reply.key, 'sending', 'failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      sending.delete(reply.key)
    }
  }

  const onEvent = (event: DwsEvent): void => {
    const recordError = (error: unknown): void => {
      lastError = error instanceof Error ? error.message : String(error)
    }
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
    currentSetup = readSetup()
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
        await deliverInbox(inboxKey, binding, row.event, row.body)
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
      if (ledger.readError) {
        lastError = `DingTalk ledger unreadable, connector not started: ${ledger.readError}`
        throw new Error(lastError)
      }
      running = true
      currentSetup = readSetup()
      const seam = deps.seam()
      if (seam) {
        releaseWatch = seam.watch(deps.host(), (event) => {
          if (event.kind === 'turn-ended') {
            handleTurn(event)
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
