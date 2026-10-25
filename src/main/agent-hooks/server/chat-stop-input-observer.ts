import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  ChatStopBinding,
  ChatStopInput,
  WriteSettlementSink
} from '../../../shared/chat-stop-input'
import {
  AGENT_INTERRUPT_SETTLE_MS,
  requiresDoubleEscapeInterrupt,
  type AgentInterruptInferenceRequest
} from '../../../shared/agent-interrupt-intent'
import { nativeChatStopEscapeCount } from '../../../shared/native-chat-agent-support'

const EVIDENCE_LIFETIME_MS = 37_000

type Observation = {
  id: string
  seen: number
  accepted: number
  closed: boolean
  row?: AgentHookEventPayload
  binding?: ChatStopBinding
  request?: AgentInterruptInferenceRequest
  required: number
  expiry: ReturnType<typeof setTimeout>
  grace?: ReturnType<typeof setTimeout>
}

export class ChatStopInputObserver {
  private readonly panes = new Map<string, Observation>()

  constructor(
    private readonly read: (paneKey: string) => AgentHookEventPayload | undefined,
    private readonly infer: (request: AgentInterruptInferenceRequest) => boolean
  ) {}

  clear(paneKey?: string): void {
    if (paneKey === undefined) {
      for (const key of this.panes.keys()) {
        this.clear(key)
      }
      return
    }
    const entry = this.panes.get(paneKey)
    if (!entry) {
      return
    }
    this.close(entry)
    clearTimeout(entry.expiry)
    this.panes.delete(paneKey)
  }

  private close(entry: Observation): void {
    entry.closed = true
    entry.row = undefined
    entry.request = undefined
    entry.binding = undefined
    clearTimeout(entry.grace)
    entry.grace = undefined
  }

  capture(paneKey: string, input: ChatStopInput, binding: ChatStopBinding): WriteSettlementSink {
    let entry = this.panes.get(paneKey)
    if (!entry || (entry.id !== input.id && input.index === 1)) {
      this.clear(paneKey)
      const row = input.index === 1 ? this.read(paneKey) : undefined
      entry = {
        id: input.id,
        seen: 0,
        accepted: 0,
        closed: true,
        required: 1,
        expiry: setTimeout(() => this.clear(paneKey), EVIDENCE_LIFETIME_MS)
      }
      this.panes.set(paneKey, entry)
      if (
        row &&
        !row.connectionId &&
        'receivedAt' in row &&
        typeof row.receivedAt === 'number' &&
        'stateStartedAt' in row &&
        typeof row.stateStartedAt === 'number'
      ) {
        entry.row = row
        entry.binding = binding
        entry.closed = false
        entry.required = Math.max(
          nativeChatStopEscapeCount(row.payload.agentType),
          requiresDoubleEscapeInterrupt(row.payload.agentType, 'plain-escape') ? 2 : 1
        )
        entry.request = {
          paneKey,
          intent: 'plain-escape',
          baselineUpdatedAt: row.receivedAt,
          baselineStateStartedAt: row.stateStartedAt,
          baselinePrompt: row.payload.prompt,
          baselineAgentType: row.payload.agentType
        }
      }
    }
    const original = entry
    const bit = 1 << (input.index - 1)
    if (
      original.id !== input.id ||
      original.closed ||
      original.seen & bit ||
      original.binding?.ptyId !== binding.ptyId ||
      original.binding.processIncarnation !== binding.processIncarnation ||
      original.binding.generation !== binding.generation
    ) {
      return () => {}
    }
    original.seen |= bit
    let settled = false
    return (result) => {
      if (settled || original.closed || this.panes.get(paneKey) !== original) {
        return
      }
      settled = true
      if (result.outcome !== 'accepted') {
        return
      }
      original.accepted |= bit
      const attempt = (): void => {
        const { row, request, binding: target } = original
        if (!original.closed && this.panes.get(paneKey) === original && row && request && target) {
          try {
            if (this.read(paneKey) === row && target.isCurrent()) {
              this.infer({ ...request, inputCount: original.required === 2 ? 2 : 1 })
            }
          } catch {
            /* Status observation never changes delivery. */
          } finally {
            this.close(original)
          }
        }
      }
      if (original.required === 2) {
        if (original.accepted === 3) {
          attempt()
        }
      } else if (!original.grace) {
        original.grace = setTimeout(attempt, AGENT_INTERRUPT_SETTLE_MS)
      }
    }
  }
}
