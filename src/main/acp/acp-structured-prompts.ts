// Claim requests through journal commit before replying so competing clients cannot answer twice.

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
  /** Protocol cancellation can answer permissions immediately, even while a claim is saved. */
  permission: boolean
  signal: AbortSignal
  claimed: boolean
  /** Deferred withdrawal applies if the claimed answer fails to save. */
  withdrawing: boolean
  settle: (reply: unknown) => void
}

export class AcpStructuredPrompts {
  private readonly open = new Map<string, OpenRequest>()

  constructor(
    private readonly lane: () => AcpStructuredLane | null,
    /** Allows interactive requests for the current turn. */
    private readonly admits: () => boolean,
    /** Allows content from requests that settled immediately. */
    private readonly shows: () => boolean
  ) {}

  get size(): number {
    return this.open.size
  }

  handle(method: string, params: unknown, context: AcpRequestContext): Promise<unknown> {
    const lane = this.lane()
    if (!lane || context.id === null) {
      throw new AcpRpcError(-32603, 'ACP request arrived with no session to show it')
    }
    const translated = lane.translator.request(method, params, context.id)
    if (translated.settled) {
      if (this.shows()) {
        lane.apply(translated.events)
      }
      return Promise.resolve(translated.settled.reply)
    }
    if (translated.presentation && !this.admits()) {
      // Reply cancelled without opening a card when the turn can no longer ask.
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
      // Unclaimed requests withdraw immediately; claimed answers finish their commit.
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
      // Protocol cancellation already replied while the permission answer was being saved.
      throw new Error(`the agent stopped waiting for the answer to ${input.itemId}`)
    }
  }

  /** Cancel unclaimed requests; let claimed answers finish saving. */
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
