// The agent's open requests to the user (permission, question, plan approval), each held as the
// JSON-RPC call it is until a person answers it, a Stop cancels it, or the agent withdraws it.
// An answer claims the request, commits the journal compare-and-set while the claim is held, and
// only then replies, so a second client loses the commit and the agent hears exactly one answer.
// Each request is this module's to answer: once the agent cancels it, or a Stop or steer withdraws
// what is open (`withdrawAll`), an unclaimed one is answered with the agent's own cancelled reply
// and a claimed one still sends the committed answer — except a permission the agent itself
// cancelled, which the protocol answers `cancelled` the moment it is cancelled.

import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import type { AcpStructuredLane } from './acp-structured-lane'

type OpenRequest = {
  key: string
  presentation: AcpRequestPresentation
  /** A permission, whose cancellation the protocol answers itself. */
  permission: boolean
  signal: AbortSignal
  claimed: boolean
  /** A Stop or steer withdrew it while an answer was being saved: a failed save withdraws it. */
  withdrawing: boolean
  settle: (reply: unknown) => void
}

export class AcpStructuredPrompts {
  private readonly open = new Map<string, OpenRequest>()

  constructor(
    private readonly lane: () => AcpStructuredLane | null,
    /** Whether a request arriving now belongs to a turn that may still ask the person. */
    private readonly admits: () => boolean,
    /** Whether its turn may still show what a request answered at once carried. */
    private readonly shows: () => boolean
  ) {}

  get size(): number {
    return this.open.size
  }

  /** Answers one agent request: a row the user can act on, or the translator's verdict on it. */
  handle(method: string, params: unknown, context: AcpRequestContext): Promise<unknown> {
    const lane = this.lane()
    if (!lane || context.id === null) {
      throw new AcpRpcError(-32603, 'ACP request arrived with no session to show it')
    }
    const translated = lane.translator.request(method, params, context.id)
    if (translated.settled) {
      // Answered at once; what it carried shows only while its turn may still show anything.
      if (this.shows()) {
        lane.apply(translated.events)
      }
      return Promise.resolve(translated.settled.reply)
    }
    if (translated.presentation && !this.admits()) {
      // No prompt of Orca's runs, or a Stop or steer is cutting it short: the agent hears its own
      // cancelled reply and no card opens.
      return Promise.resolve(translated.presentation.reply(null))
    }
    lane.apply(translated.events)
    const opened = translated.events.find((event) => event.type === 'request.open')
    if (!translated.presentation || opened?.type !== 'request.open') {
      throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`)
    }
    const key = opened.request
    const presentation = translated.presentation
    return new Promise((resolve) => {
      const entry: OpenRequest = {
        key,
        presentation,
        permission: method === 'session/request_permission',
        signal: context.signal,
        claimed: false,
        withdrawing: false,
        settle: (reply) => {
          if (this.open.get(key) === entry) {
            this.open.delete(key)
          }
          resolve(reply)
        }
      }
      this.open.set(key, entry)
      // The agent or a Stop gave up on it: its card can no longer be answered, and the agent hears
      // its own cancelled reply. A claimed one finishes its answer.
      context.signal.addEventListener(
        'abort',
        () => {
          if (this.open.get(key) === entry && !entry.claimed) {
            this.withdraw(entry)
          }
        },
        { once: true }
      )
    })
  }

  async answer(input: {
    itemId: string
    response: AgentSessionPromptResponse
    commit: () => Promise<void>
  }): Promise<void> {
    const entry = this.find(input.itemId)
    if (!entry) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    let reply: unknown
    try {
      reply = entry.presentation.reply(input.response)
    } catch (error) {
      throw new AgentSessionPromptAnswerRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    entry.claimed = true
    try {
      await input.commit()
    } catch (error) {
      entry.claimed = false
      if (entry.signal.aborted || entry.withdrawing) {
        this.withdraw(entry)
      }
      throw error
    }
    entry.settle(reply)
    if (entry.permission && entry.signal.aborted) {
      // Cancelled while the answer was saved: the agent already heard `cancelled`, not this answer.
      throw new Error(`the agent stopped waiting for the answer to ${input.itemId}`)
    }
  }

  /** A Stop or steer: the agent hears its own cancelled reply to everything no answer has claimed. */
  withdrawAll(): void {
    for (const entry of this.open.values()) {
      if (entry.claimed) {
        entry.withdrawing = true
      } else {
        this.withdraw(entry)
      }
    }
  }

  private withdraw(entry: OpenRequest): void {
    entry.settle(entry.presentation.reply(null))
    this.lane()?.apply([{ type: 'request.withdrawn', request: entry.key }])
  }

  /** The child is gone: nobody can answer for it any more. */
  clear(): void {
    this.open.clear()
  }

  private find(itemId: string): OpenRequest | null {
    const lane = this.lane()
    if (!lane) {
      return null
    }
    for (const entry of this.open.values()) {
      if (!entry.claimed && lane.isRequestRow(itemId, entry.key)) {
        return entry
      }
    }
    return null
  }
}
