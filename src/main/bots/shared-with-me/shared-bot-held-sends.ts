// A teammate's messages held in Orca Cloud for a shared agent's host: where a send goes, the held
// states the cloud reports, and Send again for one the host refused.
import { UNKNOWN_SHARE_REFUSAL } from '../../../shared/connector-share-contract'
import { agentShareCloudReason, reportAgentShareFailure } from '../../telemetry/agent-share-failure'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  isSharedBotNewChatId,
  newSharedBotChatId,
  SHARED_HOSTS_HOLD_WHILE_AWAY,
  type SharedBotHeldState,
  type SharedBotHeldView
} from '../../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  sharedBotHeldChat,
  sharedBotHeldRefusal
} from '../../../shared/bots/shared-bot-held-routing'
import { sharedBotFailure, sharedBotOffline } from './shared-bot-host-answers'
import { handOffSharedBotMessage, type HandOffResult } from './shared-bot-hand-off'
import {
  sharedBotHostKey,
  type SharedBotHeldMessage,
  type SharedBotHostEntry,
  type SharedBotHostStore
} from './shared-bot-host-store'
import {
  sendsHeld,
  sharedBotHeldChatId,
  type MineShare,
  type SharedBotLink
} from './shared-bot-pairing'
import {
  SharedBotHeldUploads,
  SHARED_BOT_UPLOAD_METHODS,
  type SharedBotHeldAttachment
} from './shared-bot-held-uploads'
import type { SharedBotsCloud } from './shared-bots-cloud'

// A new chat started live under the id its held messages name, and the session the host gave it.
const NewChatParams = z.looseObject({ newChatId: z.string() })
const StartedSession = z.looseObject({ sessionId: z.string() })
const SessionParams = z.looseObject({ sessionId: z.string() })
const EnvelopeParams = z.looseObject({ envelope: SessionParams })

/** The chat a call names, as `sessionId` or in its mutation envelope. */
const sessionIdOf = (params: unknown): string | undefined =>
  SessionParams.safeParse(params).data?.sessionId ??
  EnvelopeParams.safeParse(params).data?.envelope.sessionId

/** Whether a call names a new chat's placeholder, which the host doesn't know yet. */
export function namesSharedBotNewChat(params: unknown): boolean {
  return isSharedBotNewChatId(sessionIdOf(params))
}

export { sharedBotHeldChat } from '../../../shared/bots/shared-bot-held-routing'

export class SharedBotHeldSends {
  private states = new Map<string, SharedBotHeldState>()
  private readonly uploads = new SharedBotHeldUploads()
  // Cloud reads begun this run, and how many had begun when each message held this run was taken.
  private reads = 0
  private readonly heldAtRead = new Map<string, number>()

  constructor(
    private readonly deps: {
      store: SharedBotHostStore
      cloud: () => SharedBotsCloud | null
      now: () => number
      // A message was held: the view changed, and its state is worth reading soon.
      changed: () => void
    }
  ) {}

  /** The cloud's latest word on every held message of the account's shares. */
  applyMine(shares: readonly MineShare[]): void {
    const before = this.states
    this.states = new Map(
      shares.flatMap((share) => share.held.map((held) => [held.clientMessageId, held.state]))
    )
    for (const [clientMessageId, state] of this.states) {
      // Seen waiting, now refused: once per message, never for one already refused at launch.
      if (state === 'not_sent' && before.get(clientMessageId) === 'waiting') {
        reportAgentShareFailure({ stage: 'held_not_sent', reason: 'refused' })
      }
    }
  }

  /** A cloud read begins; its answer settles the holds taken before it began. */
  beginRead(): number {
    return ++this.reads
  }

  /**
   * A share's held messages after the cloud read `read`: one it lists stays; one it doesn't is gone
   * (delivered and aged out, or pruned) once that read began after the message was held. A read that
   * was already out can't list it yet, so it is kept. One kept from an earlier run is settled by the
   * first read. No clock is compared.
   */
  settle(held: readonly SharedBotHeldMessage[], read: number): SharedBotHeldMessage[] {
    return held.filter(
      (message) =>
        this.states.has(message.clientMessageId) ||
        read <= (this.heldAtRead.get(message.clientMessageId) ?? 0)
    )
  }

  isWaiting(held: SharedBotHeldMessage): boolean {
    return this.state(held) === 'waiting'
  }

  views(entry: SharedBotHostEntry): SharedBotHeldView[] {
    return entry.held.map((held) => ({
      clientMessageId: held.clientMessageId,
      sessionId: sharedBotHeldChatId(held),
      text: held.text,
      attachments: (held.attachments ?? []).map((attachment) => attachment.name),
      sentAt: held.sentAt,
      state: this.state(held)
    }))
  }

  /**
   * Holds an `agentSession.send` that can't go live, or null when it goes to the host. Once a send
   * belongs on the held queue it never goes live, held or not, so it can't overtake one waiting.
   */
  async send(
    entry: SharedBotHostEntry,
    link: SharedBotLink,
    params: unknown
  ): Promise<RuntimeRpcResponse<unknown> | null> {
    const send = SendParams.safeParse(params).data
    const sessionId = send?.envelope.sessionId
    const clientMessageId = send?.envelope.clientOperationId
    if (!send || !sessionId || !clientMessageId) {
      return null
    }
    const chat = sharedBotHeldChat(sessionId)
    if (!sendsHeld(entry, link, chat, this.states)) {
      return link === 'live' ? null : sharedBotOffline(entry)
    }
    const content = this.heldContent(send.body.blocks)
    const result = content && (await this.hold(entry, { chat, clientMessageId, ...content }))
    if (result?.kind === 'held' && content) {
      this.uploads.release(content.paths)
    }
    const unshared = result?.kind === 'failed' && result.failure.error === UNKNOWN_SHARE_REFUSAL
    if (unshared) {
      // Revoked: the cloud's list drops it now, not at the next idle read.
      this.deps.changed()
    }
    const refusal =
      result && sharedBotHeldRefusal(unshared ? 'unshared' : result.kind, entry.ownerName)
    // Not held (refused, unsupported, no cloud): still never sent live ahead of the queue.
    return refusal ? sharedBotFailure('agentSession.send', ...refusal) : sharedBotOffline(entry)
  }

  /**
   * A call this device answers for a host that isn't reached live: an attachment upload for a chat
   * whose next message will be held (kept here to be sealed into it), or a new chat started while
   * the host is away (a placeholder until its first held message starts it there). Null otherwise.
   */
  answerHere(
    entry: SharedBotHostEntry,
    link: SharedBotLink,
    method: string,
    params: unknown
  ): RuntimeRpcResponse<unknown> | null {
    if (method === 'bots.session.start') {
      // A start naming a placeholder is its swap to the real chat: only the host answers it, so a
      // link that dropped meanwhile leaves that placeholder in place rather than minting another.
      return SHARED_HOSTS_HOLD_WHILE_AWAY &&
        link !== 'live' &&
        entry.hostKey &&
        !NewChatParams.safeParse(params).success
        ? {
            id: method,
            ok: true,
            result: { sessionId: newSharedBotChatId(randomUUID()) },
            _meta: { runtimeId: entry.environmentId }
          }
        : null
    }
    const sessionId = sessionIdOf(params)
    const keeps =
      SHARED_BOT_UPLOAD_METHODS.has(method) &&
      (this.uploads.owns(params) ||
        (sessionId !== undefined &&
          sendsHeld(entry, link, sharedBotHeldChat(sessionId), this.states)))
    return keeps ? this.uploads.call(method, params, entry.ownerName) : null
  }

  /** A live answer this owner learns from: a new chat started under the id its held messages name. */
  noteAnswer(
    entry: SharedBotHostEntry,
    method: string,
    params: unknown,
    response: RpcResponse
  ): void {
    const newChat = method === 'bots.session.start' ? NewChatParams.safeParse(params).data : null
    const started = response.ok ? StartedSession.safeParse(response.result).data : undefined
    if (newChat && started) {
      this.started(entry, newChat.newChatId, started.sessionId)
    }
  }

  /** The host started the new chat `newChatId` as `sessionId`: its held messages land there, and
   *  that chat's later messages wait behind them. */
  started(entry: SharedBotHostEntry, newChatId: string, sessionId: string): void {
    const current = this.deps.store.get(entry.shareId) ?? entry
    if (!current.held.some((held) => sharedBotHeldChatId(held) === newChatId)) {
      return
    }
    this.deps.store.put({
      ...current,
      held: current.held.map((held) =>
        sharedBotHeldChatId(held) === newChatId ? { ...held, startedAs: sessionId } : held
      )
    })
    this.deps.changed()
  }

  /** A live send; its attachments kept here while the host was away go to its store first. */
  sendWithKept(
    params: unknown,
    request: (method: string, params: unknown) => Promise<RpcResponse>
  ): Promise<RpcResponse> {
    return this.uploads.sendWithKept(params, request)
  }

  /** Holds a refused message again under a new id, in place of the refused one. */
  async sendAgain(entry: SharedBotHostEntry, clientMessageId: string): Promise<boolean> {
    const refused = entry.held.find(
      (held) => held.clientMessageId === clientMessageId && this.state(held) === 'not_sent'
    )
    if (!refused) {
      return false
    }
    const result = await this.hold(
      entry,
      {
        chat: refused.chat,
        clientMessageId: randomUUID(),
        text: refused.text,
        attachments: refused.attachments ?? []
      },
      clientMessageId,
      refused.startedAs
    )
    return result?.kind === 'held'
  }

  private async hold(
    entry: SharedBotHostEntry,
    message: {
      chat: SharedBotHeldMessage['chat']
      clientMessageId: string
      text: string
      attachments: readonly SharedBotHeldAttachment[]
    },
    replaces?: string,
    startedAs?: string
  ): Promise<HandOffResult | null> {
    const hostKey = sharedBotHostKey(entry)
    const cloud = this.deps.cloud()
    if (!hostKey || !cloud) {
      return null
    }
    const result = await handOffSharedBotMessage(cloud, entry, hostKey, {
      ...message,
      sentAt: this.deps.now()
    })
    if (result.kind !== 'held') {
      reportAgentShareFailure({
        stage: 'held_send',
        reason: result.kind === 'too-large' ? 'too_large' : agentShareCloudReason(result.failure)
      })
    }
    if (result.kind === 'held') {
      const current = this.deps.store.get(entry.shareId) ?? entry
      this.deps.store.put({
        ...current,
        held: [
          ...current.held.filter((held) => held.clientMessageId !== replaces),
          startedAs ? { ...result.held, startedAs } : result.held
        ]
      })
      this.states.set(result.held.clientMessageId, 'waiting')
      this.heldAtRead.set(result.held.clientMessageId, this.reads)
      this.deps.changed()
    }
    return result
  }

  /** The words and attachments a held message carries; null when a block can't be held (an
   *  attachment already in the host's store, or anything but text and attachments). */
  private heldContent(blocks: readonly { type: string; text?: string; path?: string }[]): {
    text: string
    attachments: SharedBotHeldAttachment[]
    paths: string[]
  } | null {
    const texts: string[] = []
    const attachments: SharedBotHeldAttachment[] = []
    const paths: string[] = []
    for (const block of blocks) {
      const attachment =
        block.type === 'image-ref' && block.path ? this.uploads.read(block.path) : null
      if (block.type === 'text' && block.text !== undefined) {
        texts.push(block.text)
      } else if (attachment && block.path) {
        attachments.push(attachment)
        paths.push(block.path)
      } else {
        return null
      }
    }
    return { text: texts.join('\n\n'), attachments, paths }
  }

  private state(held: SharedBotHeldMessage): SharedBotHeldState {
    return this.states.get(held.clientMessageId) ?? 'waiting'
  }
}
