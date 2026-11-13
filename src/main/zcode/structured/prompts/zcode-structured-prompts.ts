import type { AgentSessionPromptResponse } from '../../../../shared/agent-session/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import { zcodeInteractionPresentation } from './zcode-structured-interactions'

// Claim interaction requests through journal commit before replying so competing clients cannot
// answer twice. zcode reannounces an unanswered request every ~1s with the same `requestId` but a
// fresh frame id; the first frame opens the journal row and every later frame joins its answer.

type OpenRequest = {
  key: string
  /** zcode's own correlation id, shared by every reannounce of this request. */
  requestId: string | null
  /** Every frame this request announced under; the answer replies on all of them. */
  frameIds: (number | string)[]
  reply: (response: AgentSessionPromptResponse | null) => unknown
  claimed: boolean
  withdrawing: boolean
  settle: (reply: unknown) => void
}

export type ZcodePromptsDeps = {
  lane: () => ZcodeStructuredLane | null
  /** Interactive requests need someone who can answer them. */
  admits: () => boolean
  /** Replies to the provider on one announced frame. */
  respond: (frameId: number | string, reply: unknown) => void
}

export class ZcodeStructuredPrompts {
  private readonly open = new Map<string, OpenRequest>()

  constructor(private readonly deps: ZcodePromptsDeps) {}

  get size(): number {
    return this.open.size
  }

  handle(method: string, params: unknown, frameId: number | string): Promise<unknown> {
    const existing = this.findByRequest(params)
    if (existing) {
      // A reannounce of a request we already opened joins its answer.
      if (!existing.frameIds.includes(frameId)) {
        existing.frameIds.push(frameId)
      }
      return new Promise((resolve) => {
        const previousSettle = existing.settle
        existing.settle = (reply) => {
          previousSettle(reply)
          resolve(reply)
        }
      })
    }
    const presentation = zcodeInteractionPresentation(method, params)
    if (!presentation) {
      throw new Error(`zcode sent an interaction this chat cannot answer: ${method}`)
    }
    const lane = this.deps.lane()
    if (!lane || !this.deps.admits()) {
      // Nobody can answer during Stop or teardown; decline at once so the provider's request
      // never waits on a client that cannot respond. No entry is registered, so answer()
      // cannot double-send this frame.
      const reply = presentation.reply(null)
      this.deps.respond(frameId, reply)
      return Promise.resolve(reply)
    }
    const key = `${method}:${JSON.stringify(frameId)}`
    const events: ProviderTimelineEvent[] = [
      {
        type: 'request.open',
        request: key,
        body: presentation.body,
        join: { thread: lane.translator.providerSessionId },
        outlivesTurn: true
      }
    ]
    lane.apply(events)
    return new Promise((resolve) => {
      const entry: OpenRequest = {
        key,
        requestId: presentation.requestId,
        frameIds: [frameId],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        reply: presentation.reply as (response: AgentSessionPromptResponse | null) => unknown,
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
    })
  }

  async answer(input: {
    itemId: string
    response: AgentSessionPromptResponse
    commit: () => Promise<void>
  }): Promise<void> {
    const entry = this.findByItemId(input.itemId)
    if (!entry) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    let reply: unknown
    try {
      reply = entry.reply(input.response)
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
      if (entry.withdrawing) {
        this.withdraw(entry)
      }
      throw error
    }
    entry.settle(reply)
    // One answer settles every announced frame of this request.
    for (const frameId of entry.frameIds) {
      this.deps.respond(frameId, reply)
    }
    this.deps.lane()?.apply([{ type: 'request.withdrawn', request: entry.key }])
  }

  /** Cancel unclaimed requests; claimed answers keep saving. */
  withdrawAll(): void {
    for (const entry of this.open.values()) {
      if (entry.claimed) {
        entry.withdrawing = true
      } else {
        this.withdraw(entry)
      }
    }
  }

  clear(): void {
    this.open.clear()
  }

  private withdraw(entry: OpenRequest): void {
    const reply = entry.reply(null)
    entry.settle(reply)
    for (const frameId of entry.frameIds) {
      this.deps.respond(frameId, reply)
    }
    this.deps.lane()?.apply([{ type: 'request.withdrawn', request: entry.key }])
  }

  private findByItemId(itemId: string): OpenRequest | null {
    for (const entry of this.open.values()) {
      if (!entry.claimed && entry.key === itemId) {
        return entry
      }
    }
    return null
  }

  private findByRequest(params: unknown): OpenRequest | null {
    const requestId = readString(readRecord(params)?.requestId)
    if (!requestId) {
      return null
    }
    for (const entry of this.open.values()) {
      if (entry.requestId === requestId) {
        return entry
      }
    }
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
