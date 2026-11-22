// Claim requests through journal commit before replying so competing clients cannot answer twice.

import type { AgentSessionPromptResponse } from '../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { AcpRequestPresentation } from '../acp-dialects/acp-dialect'
import { AcpRpcError } from '../transport/acp-errors'
import { ACP_FORM_ELICITATION_METHOD } from './acp-form-elicitation'
import { acpUrlElicitationPresentation, isAcpUrlElicitation } from './acp-url-elicitation'
import type { AcpRequestContext } from '../transport/acp-json-rpc-peer'
import type { AcpStructuredLane } from '../journal/acp-structured-lane'

import type { AcpPermissionHandler } from '../protocol/acp-permission-requests'
import { RequestPermissionResponseSchema } from '../generated/acp-protocol.generated'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpAnswersRequests } from '../launch/acp-launch-permission-modes'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'

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
    /** Allows interactive requests and content from requests that settled immediately. */
    private readonly admits: () => boolean
  ) {}

  get size(): number {
    return this.open.size
  }

  permissionHandler(
    spec: AcpLaunchSpec,
    permission: () => AgentChatPermissionChoice | undefined
  ): AcpPermissionHandler | undefined {
    if (spec.autonomousTools) {
      return undefined
    }
    return (request, context) => {
      if (!this.admits()) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const claimed = spec.dialect.request?.('session/request_permission', request)
      if (permission() === 'full-access' && acpAnswersRequests(spec) && !claimed) {
        const allow = request.options.find((option) => option.kind === 'allow_once')
        if (allow) {
          return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
      }
      return this.handle('session/request_permission', request, context).then((reply) =>
        RequestPermissionResponseSchema.parse(reply)
      )
    }
  }

  handle(method: string, params: unknown, context: AcpRequestContext): Promise<unknown> {
    const lane = this.lane()
    // No session can show a sign-in page yet; cancelling lets the agent report that sign-in is needed.
    if (
      !lane &&
      context.id !== null &&
      method === ACP_FORM_ELICITATION_METHOD &&
      isAcpUrlElicitation(params)
    ) {
      return Promise.resolve(acpUrlElicitationPresentation(params).reply(null))
    }
    if (!lane || context.id === null) {
      throw new AcpRpcError(-32603, 'ACP request arrived with no session to show it')
    }
    const translated = lane.translator.request(method, params, context.id)
    if (translated.settled) {
      if (this.admits()) {
        lane.apply(translated.events)
      }
      return Promise.resolve(translated.settled.reply)
    }
    if (translated.presentation && (!this.admits() || context.signal.aborted)) {
      // Reply cancelled without opening a card when nobody can answer.
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
            this.lane()?.agentTurn.awaitRequests(this.open.size > 0)
          }
          resolve(reply)
        }
      }
      this.open.set(key, entry)
      lane.agentTurn.awaitRequests(true)
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
    // Release the timeline's hold; withdrawal keeps the committed answer.
    const lane = this.lane()
    lane?.apply([
      { type: 'request.withdrawn', request: entry.key },
      // A URL request's completion that arrived before the answer was saved applies now.
      ...lane.translator.elicitations.answered(entry.key)
    ])
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
    this.lane()?.agentTurn.awaitRequests(false)
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
