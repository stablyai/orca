// A teammate's messages held in Orca Cloud for a shared agent's host: where a send goes, and the held
// states the cloud reports.
import {
  SHARED_BOT_HOST_ERRORS,
  type SharedBotHeldState
} from '../../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { handOffSharedBotMessage, type HandOffResult } from './shared-bot-hand-off'
import type {
  SharedBotHeldMessage,
  SharedBotHostEntry,
  SharedBotHostStore
} from './shared-bot-host-store'
import { sendsHeld, type MineShare, type SharedBotLink } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'

export const sharedBotFailure = (
  id: string,
  code: string,
  message: string
): RuntimeRpcResponse<unknown> => ({ id, ok: false, error: { code, message } })

export class SharedBotHeldSends {
  private states = new Map<string, SharedBotHeldState>()
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
    this.states = new Map(
      shares.flatMap((share) => share.held.map((held) => [held.clientMessageId, held.state]))
    )
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
    const chat = { sessionId }
    if (!sendsHeld(entry, link, chat, this.states)) {
      return link === 'live' ? null : sharedBotOffline(entry)
    }
    const result = await this.hold(entry, { chat, clientMessageId, blocks: send.body.blocks })
    if (result?.kind === 'held') {
      return sharedBotFailure(
        'agentSession.send',
        SHARED_BOT_HOST_ERRORS.held,
        `Waiting for ${entry.ownerName}’s computer`
      )
    }
    if (result?.kind === 'too-large') {
      return sharedBotFailure(
        'agentSession.send',
        SHARED_BOT_HOST_ERRORS.tooLarge,
        `Too large to hold; send it when ${entry.ownerName}’s computer is online`
      )
    }
    // Not held (refused, unsupported, no cloud): still never sent live ahead of the queue.
    return sharedBotOffline(entry)
  }

  private async hold(
    entry: SharedBotHostEntry,
    message: {
      chat: SharedBotHeldMessage['chat']
      clientMessageId: string
      blocks: readonly { type: string }[]
    }
  ): Promise<HandOffResult | null> {
    const { hostKey } = entry
    const cloud = this.deps.cloud()
    if (!hostKey || !cloud) {
      return null
    }
    const result = await handOffSharedBotMessage(
      cloud,
      { ...entry, hostKey },
      { ...message, sentAt: this.deps.now() }
    )
    if (result.kind === 'held') {
      const current = this.deps.store.get(entry.shareId) ?? entry
      this.deps.store.put({ ...current, held: [...current.held, result.held] })
      this.states.set(result.held.clientMessageId, 'waiting')
      this.heldAtRead.set(result.held.clientMessageId, this.reads)
      this.deps.changed()
    }
    return result
  }

  private state(held: SharedBotHeldMessage): SharedBotHeldState {
    return this.states.get(held.clientMessageId) ?? 'waiting'
  }
}

/** A call the host wasn't reached for, and nothing was held for. */
export function sharedBotOffline(
  entry: SharedBotHostEntry,
  method = 'agentSession.send'
): RuntimeRpcResponse<unknown> {
  return sharedBotFailure(
    method,
    SHARED_BOT_HOST_ERRORS.offline,
    `${entry.ownerName}’s computer is offline`
  )
}
