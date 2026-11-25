// A phone's messages to a shared agent whose host is away: sealed to the host's key, signed with the
// phone's key, and held in Orca Cloud with its share credential. Their states come from Orca Cloud's
// read of that share's held messages; a refused one can be sent again.
import nacl from 'tweetnacl'
import { z } from 'zod'
import { sealBotTeamShareHeldMessage } from '../../../../src/shared/bots/bot-team-share-seal'
import {
  sendsHeldTo,
  sharedBotHeldChat,
  sharedBotHeldChatId,
  type SharedBotHeldChat
} from '../../../../src/shared/bots/shared-bot-held-routing'
import {
  newSharedBotChatId,
  type SharedBotHeldState,
  type SharedBotHeldView
} from '../../../../src/shared/bots/shared-bot-hosts'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import { MAX_HELD_MESSAGE_CHARS } from '../../../../src/shared/connector-share-contract'
import type { SharedHostLink } from '../../../../src/shared/remote-runtime/relay/client/shared-host-relay-link'
import { SendParams } from '../../../../src/shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import { phoneSharedAgentCloud } from './phone-shared-agent-cloud'
import type {
  PhoneSharedAgent,
  PhoneSharedAgentHeld as Held,
  PhoneSharedAgentStore
} from './phone-shared-agent-store'

// Orca Cloud's requestWaitMs: a held message not delivered by then is dropped.
export const HELD_WAIT_MS = 24 * 60 * 60 * 1000

/** `unshared`: Orca Cloud knows no such share for this credential any more (revoked). */
export type HoldResult = 'held' | 'too-large' | 'unshared' | 'failed'

// A new chat started live under the id its held messages name, and the session the host gave it.
const NewChatParams = z.looseObject({ newChatId: z.string() })
const StartedSession = z.looseObject({ sessionId: z.string() })

export class PhoneSharedAgentHeld {
  private states = new Map<string, SharedBotHeldState>()
  // Reads begun this run, and how many had begun when each message held this run was taken.
  private reads = 0
  private readonly heldAtRead = new Map<string, number>()

  constructor(
    private readonly deps: {
      store: PhoneSharedAgentStore
      now: () => number
      changed: () => void
    }
  ) {}

  /** Whether a send to `entry`'s host is held: see `sendsHeldTo`. */
  sendsHeld(entry: PhoneSharedAgent, link: SharedHostLink, chat: SharedBotHeldChat): boolean {
    const states = new Map(entry.held.map((held) => [held.clientMessageId, this.state(held)]))
    return sendsHeldTo(entry.hostKey, entry.held, link, chat, states)
  }

  /** The words an `agentSession.send` would hold, or null when it isn't one this phone can hold
   *  (a photo or file, which waits for the host). */
  heldSend(
    params: unknown
  ): { chat: SharedBotHeldChat; clientMessageId: string; text: string } | null {
    const send = SendParams.safeParse(params).data
    const sessionId = send?.envelope.sessionId
    const clientMessageId = send?.envelope.clientOperationId
    if (!send || !sessionId || !clientMessageId) {
      return null
    }
    const texts: string[] = []
    for (const block of send.body.blocks) {
      if (block.type !== 'text') {
        return null
      }
      texts.push(block.text)
    }
    return { chat: sharedBotHeldChat(sessionId), clientMessageId, text: texts.join('\n\n') }
  }

  /**
   * A new chat started while the host is away: a placeholder until its first held message starts it
   * there. A start naming a placeholder is its swap to the real chat, which only the host answers.
   */
  startHere(
    holds: boolean,
    link: SharedHostLink,
    method: string,
    params: unknown
  ): RpcResponse | null {
    if (
      !holds ||
      method !== 'bots.session.start' ||
      link === 'live' ||
      NewChatParams.safeParse(params).success
    ) {
      return null
    }
    return { id: method, ok: true, result: { sessionId: newSharedBotChatId(randomV4Uuid()) } }
  }

  /** A live answer this owner learns from: the host started a new chat under its placeholder's id,
   *  so that chat's held messages land there and its later ones wait behind them. */
  noteAnswer(
    entry: PhoneSharedAgent,
    method: string,
    params: unknown,
    response: RpcResponse
  ): void {
    const newChat = method === 'bots.session.start' ? NewChatParams.safeParse(params).data : null
    const started = response.ok ? StartedSession.safeParse(response.result).data : undefined
    const current = this.deps.store.get(entry.shareId) ?? entry
    if (
      !newChat ||
      !started ||
      !current.held.some((held) => sharedBotHeldChatId(held) === newChat.newChatId)
    ) {
      return
    }
    this.deps.store.put({
      ...current,
      held: current.held.map((held) =>
        sharedBotHeldChatId(held) === newChat.newChatId
          ? { ...held, startedAs: started.sessionId }
          : held
      )
    })
    this.deps.changed()
  }

  async hold(
    entry: PhoneSharedAgent,
    message: { chat: SharedBotHeldChat; clientMessageId: string; text: string },
    replaces?: string,
    startedAs?: string
  ): Promise<HoldResult> {
    const sentAt = this.deps.now()
    const secretKey = PRIMITIVES.decodeBase64(entry.deviceKey.secretKeyB64)
    const sealed = await sealBotTeamShareHeldMessage(PRIMITIVES, {
      hostKey: entry.hostKey,
      message: {
        v: 1,
        shareId: entry.shareId,
        botId: entry.botId,
        chat: message.chat,
        clientMessageId: message.clientMessageId,
        text: message.text,
        attachments: [],
        sentAt,
        devicePublicKey: entry.deviceKey.publicKeyB64
      },
      sign: async (bytes) => nacl.sign.detached(bytes, secretKey)
    })
    if (sealed.length > MAX_HELD_MESSAGE_CHARS) {
      return 'too-large'
    }
    const answer = await phoneSharedAgentCloud(entry).hold({
      v: 1,
      clientMessageId: message.clientMessageId,
      sealed
    })
    if (!answer.ok) {
      return answer.status === 404 ? 'unshared' : 'failed'
    }
    const current = this.deps.store.get(entry.shareId) ?? entry
    const held: Held = { ...message, sentAt, ...(startedAs ? { startedAs } : {}) }
    this.deps.store.put({
      ...current,
      held: [...current.held.filter((kept) => kept.clientMessageId !== replaces), held]
    })
    this.states.set(message.clientMessageId, 'waiting')
    this.heldAtRead.set(message.clientMessageId, this.reads)
    this.deps.changed()
    return 'held'
  }

  /** Holds a refused message again under a new id, in place of the refused one. */
  async sendAgain(entry: PhoneSharedAgent, clientMessageId: string): Promise<boolean> {
    const refused = entry.held.find(
      (held) => held.clientMessageId === clientMessageId && this.state(held) === 'not_sent'
    )
    if (!refused) {
      return false
    }
    const message = { chat: refused.chat, clientMessageId: randomV4Uuid(), text: refused.text }
    return (await this.hold(entry, message, clientMessageId, refused.startedAs)) === 'held'
  }

  /**
   * Reads the share's held states. A message Orca Cloud lists keeps its state; one it doesn't is gone
   * (delivered and aged out) once a read that began after it was held answers. No clock is compared.
   * False when Orca Cloud didn't answer.
   */
  async refresh(entry: PhoneSharedAgent): Promise<boolean> {
    if (entry.held.length === 0) {
      return true
    }
    const read = ++this.reads
    const answer = await phoneSharedAgentCloud(entry).held()
    if (!answer.ok) {
      return false
    }
    for (const held of answer.value.held) {
      this.states.set(held.clientMessageId, held.state)
    }
    const listed = new Set(answer.value.held.map((held) => held.clientMessageId))
    const current = this.deps.store.get(entry.shareId) ?? entry
    const kept = current.held.filter(
      (held) =>
        listed.has(held.clientMessageId) || read <= (this.heldAtRead.get(held.clientMessageId) ?? 0)
    )
    if (kept.length !== current.held.length) {
      this.deps.store.put({ ...current, held: kept })
    }
    this.deps.changed()
    return true
  }

  isWaiting(held: Held): boolean {
    return this.state(held) === 'waiting'
  }

  views(entry: PhoneSharedAgent): SharedBotHeldView[] {
    return entry.held.map((held) => ({
      clientMessageId: held.clientMessageId,
      sessionId: sharedBotHeldChatId(held),
      text: held.text,
      attachments: [],
      sentAt: held.sentAt,
      state: this.state(held)
    }))
  }

  // Past the cloud's wait it can only have been dropped, even with no read since to say so.
  private state(held: Held): SharedBotHeldState {
    const state = this.states.get(held.clientMessageId) ?? 'waiting'
    return state === 'waiting' && this.deps.now() - held.sentAt >= HELD_WAIT_MS ? 'not_sent' : state
  }
}
