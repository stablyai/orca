import type {
  ConnectorAsker,
  ConnectorAnswer
} from '../../shared/connectors/connector-cloud-contract'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { nameLinkedPlace } from './external-conversation-place'
import {
  type ConversationChatHost,
  chatTurnFacts,
  watchChatNews
} from './external-conversation-chat'
import { answerConversation } from './external-conversation-answer'
import { chatPromptFacts } from './external-conversation-chat-prompts'
import { startConnectorConversation } from './external-conversation-start'
import {
  chatForConversationSend,
  recoverConnectorSendLink,
  sendConnectorChat
} from './external-conversation-delivery-target'
import {
  ChatDeliveries,
  type ConnectorChatDelivery,
  type LinkableChat
} from './external-conversation-chat-delivery'
import { cancelConversation } from './external-conversation-cancel'
import { ConversationChain, refusalOf, type QueuedWork } from './external-conversation-chain'
import { GoneChats } from './external-conversation-gone-chats'
import { ConversationEvents, type ConversationWatchListener } from './external-conversation-events'
import { conversationOwnsTurn } from './external-conversation-chat-turns'
import { conversationWorkerActivities } from './external-conversation-workers'
import { chatPromptReads } from './external-conversation-prompt-standing'
import type {
  DeliveryPreparation,
  DeliveryReceipts
} from './external-conversation-delivery-receipts'
import {
  HOST_CLOCK,
  type ExternalConversationHost,
  type ExternalConversationSeamDeps
} from './external-conversation-host'
import {
  findLink,
  findLinkForSession,
  findConversationChat,
  type LinkedConversation
} from './external-conversation-links'
import { writeChatLink } from './external-conversation-link-writes'
import {
  conversationId,
  type ConnectorMessage,
  type ConnectorStartInput,
  refused,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

import { recordAdmittedTurn } from './external-conversation-last-turn'
export type { ExternalConversationSeamDeps } from './external-conversation-host'

/** One enabled period: disabling settles queued work and aborts running work at its next boundary. */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  readonly signal = this.abort.signal
  private readonly chain = new ConversationChain(this.abort.signal)
  /** Runs `work` in the conversation's queue after its deliveries; a Stop settles it or aborts it. */
  readonly queued = (key: ConversationKey, work?: QueuedWork): Promise<Delivery> =>
    this.chain.after(conversationId(key), work)
  private readonly linked = new Map<string, { key: ConversationKey; worktreeId: string }>()
  private readonly chatDeliveries = new ChatDeliveries((...link) => this.linkChat(...link))
  /** Built by the first watcher, so an unwatched seam subscribes to nothing. */
  private events: ConversationEvents | null = null
  private readonly releaseRemovals: () => void
  /** Links whose chat was deleted: dropped, and the cloud told the thread is free. */
  readonly goneChats: GoneChats

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.goneChats = new GoneChats({ ...deps, released: (dropped) => this.unlinked(dropped) })
    // Cancel removed-workspace lanes; surviving links distinguish same-path twins on other hosts.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
      for (const [id, { key, worktreeId: linkedTo }] of this.linked) {
        if (linkedTo === worktreeId && !findLink(this.deps.store, key)) {
          this.linked.delete(id)
          this.chain.cancel(id, 'agent_not_reachable')
        }
      }
    })
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.resetAccount()
    this.chatDeliveries.stopFollowing()
    this.abort.abort(reason)
  }

  /** Signed out or switched account: drop what the last account's cloud was shown; keep working. */
  resetAccount(): void {
    this.events?.reset()
    this.chatDeliveries.clear()
  }

  answer(
    host: ExternalConversationHost,
    key: ConversationKey,
    promptId: string,
    answer: string | ConnectorAnswer
  ): Promise<Delivery> {
    return answerConversation(host, { ...this.deps, events: this.events }, key, {
      promptId,
      ...(typeof answer === 'string' ? { optionId: answer } : answer),
      signal: this.abort.signal
    })
  }

  /** Receipted like a send, so a retried delivery never cancels twice. */
  cancel(
    host: ExternalConversationHost,
    key: ConversationKey,
    id: string,
    turnId?: number
  ): Promise<Delivery> {
    const seam = { ...this.deps, chain: this.chain }
    const args = turnId === undefined ? [] : [turnId]
    // A Stop bound to a turn never lands on a later one.
    const turnIsCurrent = () =>
      turnId === undefined ||
      this.replyTarget(findLink(this.deps.store, key)?.link.paneKey ?? '')?.turnId === turnId
    return this.deps.receipts.run(key, id, 'connector.cancel', args, async () =>
      turnIsCurrent()
        ? cancelConversation(host, seam, key, this.abort.signal, turnIsCurrent)
        : refused('turn_not_running')
    )
  }

  /** Whether a chat's current or next turn is a connector's delivery, not its owner's. */
  deliveredTurn(sessionId: string): boolean {
    return this.chatDeliveries.pending(sessionId)
  }

  /** Whether the chat's running turn is its conversation's, so workers it starts report there too: a
   *  turn the owner typed that the Slack mirror posted to the thread is the thread's ask as well. */
  conversationTurn(chats: ConversationChatHost | undefined, sessionId: string): boolean {
    const linked = findLinkForSession(this.deps.store, sessionId)
    return Boolean(
      linked &&
      (conversationOwnsTurn(linked.link, this.turnFacts(chats)) ||
        this.deps.slackMirror?.()?.turnPosted(sessionId))
    )
  }

  private turnFacts(chats: ConversationChatHost | undefined) {
    return chatTurnFacts(chats, this.deps.store, (id) => this.chatDeliveries.pending(id))
  }

  /** Null unless a watch runs (replies need the connector) and the chat is linked. */
  replyTarget(paneKey: string): ReturnType<ConversationEvents['replyTarget']> {
    return this.events?.replyTarget(paneKey) ?? null
  }

  /** A snapshot of every linked conversation first, then its events; returns the release. */
  watch(host: ExternalConversationHost, listener: ConversationWatchListener): () => void {
    if (this.abort.signal.aborted) {
      throw new Error('connectors_disabled')
    }
    this.events ??= new ConversationEvents({
      store: this.deps.store,
      readHookRow: this.deps.readHookRow,
      onAgentPaneChange: this.deps.onAgentPaneChange,
      ...chatPromptReads(host.chat),
      onChatNews: (listener) => (host.chat ? watchChatNews(host.chat, listener) : () => {}),
      onWatchDisposed: () => this.chatDeliveries.followUnwatched(host.chat),
      chatTurnOrigin: (sessionId, turnAt) => this.chatDeliveries.origin(sessionId, turnAt),
      ...(this.deps.actsForOf ? { actsForOf: this.deps.actsForOf } : {}),
      chatTurnDelivered: this.turnFacts(host.chat).delivered,
      runningTurnReported: this.turnFacts(host.chat).reported,
      chatTurnDelivery: (sessionId, turnAt) => this.chatDeliveries.started(sessionId, turnAt),
      chatTurnWaiting: (sessionId) => this.chatDeliveries.waiting(sessionId),
      workLinks: async (link) => (await host.bots?.workLinks(link)) ?? [],
      workerActivities: (links) => conversationWorkerActivities(host, links),
      promptsAudience: () => this.deps.promptsAudience?.() === true,
      mirrorTurn: (sessionId) => this.deps.slackMirror?.()?.turnEnded(sessionId) ?? null,
      replyFill: () => this.deps.replyFill?.() ?? null,
      ...chatPromptFacts(host.chat),
      ...HOST_CLOCK
    })
    this.chatDeliveries.stopFollowing()
    const release = this.events.watch(listener)
    this.deps.watched?.()
    return release
  }

  /** A turn end held for the owner's Slack posts, told now; false while nothing watches. */
  tellTurnEnd(event: Parameters<ConversationEvents['tell']>[0]): boolean {
    return this.events?.tell(event) ?? false
  }

  /** A bot's conversation is a native chat, which starts whether or not status hooks are on. */
  start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: ConnectorStartInput,
    preparation?: DeliveryPreparation
  ): Promise<ConversationStart> {
    return startConnectorConversation(
      {
        ...this.deps,
        enqueue: (signalWork) => this.chain.enqueue(conversationId(key), signalWork),
        deliver: (chat, delivery) => this.deliverToChat(host, key, chat, delivery, preparation),
        link: (chat, text, asker) => this.linkChat(key, chat, text, asker)
      },
      host,
      key,
      deliveryId,
      input,
      preparation
    )
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    message: ConnectorMessage,
    preparation?: DeliveryPreparation
  ): Promise<Delivery> {
    const id = conversationId(key)
    return this.deps.receipts.run(
      key,
      deliveryId,
      'connector.send',
      [message.text],
      () => {
        const queued = findLink(this.deps.store, key)
        if (queued) {
          this.linked.set(id, { key, worktreeId: queued.workspace.worktreeId })
        }
        return this.chain.enqueue(id, async (signal) => {
          const deliverySignal = preparation?.signal(signal) ?? signal
          const stopped = preparation?.stopped(deliverySignal)
          if (stopped) {
            return stopped
          }
          const linked =
            findLink(this.deps.store, key) ??
            (await recoverConnectorSendLink(this.deps, key, deliverySignal))
          if (!linked) {
            if (deliverySignal.aborted) {
              return preparation?.stopped(deliverySignal) ?? refused(refusalOf(deliverySignal))
            }
            throw new Error('external_conversation_not_found')
          }
          const chat = await chatForConversationSend(this.deps.store, host, key, linked, message)
          const delivered =
            'outcome' in chat
              ? chat
              : await this.deliverToChat(
                  host,
                  key,
                  chat,
                  { ...message, deliveryId, signal },
                  preparation
                )
          return this.goneChats.settle(key, delivered)
        })
      },
      preparation
    )
  }

  /** Its delivery receipts: what an earlier process's received delivery came to (never run again),
   *  and the receipts a batch's later sends settle through (connector-delivery-batches). */
  get receipts(): DeliveryReceipts {
    return this.deps.receipts
  }

  /** The chat a conversation is linked to on this host, if any. */
  linkedChat(key: ConversationKey, botId?: string) {
    return findConversationChat(this.deps.store, key, botId)
  }

  /**
   * Links an event's conversation to the chat its automation run already started, as a delivery would:
   * the turn's replies and final message go to the event's thread. False once connectors are off.
   */
  adoptRun(key: ConversationKey, chat: LinkableChat, text: string): boolean {
    if (this.abort.signal.aborted) {
      return false
    }
    try {
      this.chatDeliveries.adopt(key, chat, text)
    } catch (error) {
      console.warn('[connectors] could not link an automation run to its thread', error)
      return false
    }
    this.linked.set(conversationId(key), { key, worktreeId: chat.worktreeId })
    return true
  }

  /** Links a conversation to an existing native chat, which runs only on this host. */
  linkChat(
    key: ConversationKey,
    chat: LinkableChat,
    text?: string,
    asker?: Pick<ConnectorAsker, 'app' | 'name' | 'place' | 'role'>
  ): void {
    const fresh = findLink(this.deps.store, key) === null
    const written = writeChatLink(this.deps.store, key, chat, text)
    const linked = (asker && this.deps.slackMirror?.()?.opened(written, asker, fresh)) || written
    if (linked) {
      this.events?.linked(linked, this.deps.actsForOf?.(chat.sessionId))
      this.deps.onLinked?.()
    } else {
      const kept = findLink(this.deps.store, key)
      if (kept) {
        this.events?.delivered(kept.link)
      }
    }
    if (asker && chat.bot) {
      void nameLinkedPlace(this.deps, key, chat.bot.botId, asker.place, this.abort.signal)
    }
  }

  /** Which side began the chat's latest turn, as its host admitted the message. */
  messageAdmitted(message: AdmittedMessage): void {
    recordAdmittedTurn(this.deps, message)
  }

  private unlinked(dropped: LinkedConversation): void {
    this.linked.delete(conversationId(dropped.link))
    this.events?.unlinked(dropped)
    this.deps.onLinked?.()
  }

  private deliverToChat(
    host: ExternalConversationHost,
    key: ConversationKey,
    chat: LinkableChat,
    delivery: ConnectorChatDelivery,
    preparation: DeliveryPreparation | undefined
  ): Promise<Delivery> {
    this.linked.set(conversationId(key), { key, worktreeId: chat.worktreeId })
    return sendConnectorChat(this.deps, this.chatDeliveries, host, key, chat, {
      ...delivery,
      ...(preparation ? { preparation } : {})
    })
  }
}
