import { createHash } from 'node:crypto'
import type {
  AgentSessionContextUsage,
  AgentSessionTokenUsage
} from '../../../../shared/agent-session/agent-session-context-usage'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'
import { zcodeModelStreamingEvents, zcodeToolUpdatedEvents } from './zcode-tool-stream-translation'

// zcode session events → provider timeline events. One turn runs at a time; `turn.started`
// names its input (the provider echo that proves a send landed) and later events carry no
// turn id, so the translator tracks the current turn by its first id-bearing frame.

export type ZcodePromptRequest = {
  key: string
  kind: 'approval' | 'question'
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

export type ZcodeTimelineTranslatorOptions = {
  providerSessionId: string
}

type TurnStartedPayload = {
  input?: unknown
  messageId?: unknown
  queryId?: unknown
  foregroundExecutionId?: unknown
  inputSource?: unknown
}

export class ZcodeTimelineTranslator {
  readonly providerSessionId: string
  /** The provider key of the turn currently open, if any. */
  private openTurnKey: string | null = null
  /** Sends awaiting their provider echo, by the exact input text sent. */
  private readonly inFlight: { clientMessageId: string; text: string }[] = []

  constructor(options: ZcodeTimelineTranslatorOptions) {
    this.providerSessionId = options.providerSessionId
  }

  /** Arms a send so the next matching provider echo settles it. */
  beginSend(clientMessageId: string, text: string): void {
    this.inFlight.push({ clientMessageId, text })
  }

  /** A send that never became a turn leaves the in-flight roster. */
  forgetSend(clientMessageId: string): void {
    const index = this.inFlight.findIndex((send) => send.clientMessageId === clientMessageId)
    if (index !== -1) {
      this.inFlight.splice(index, 1)
    }
  }

  get currentTurnKey(): string | null {
    return this.openTurnKey
  }

  private join(turnKey: string | null): { thread: string; turn?: string } {
    return {
      thread: this.providerSessionId,
      ...(turnKey ? { turn: turnKey } : {})
    }
  }

  /** Translate one `session/event` notification into timeline events. */
  sessionEvent(type: string, payload: unknown, at: number): ProviderTimelineEvent[] {
    switch (type) {
      case 'turn.started':
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        return this.turnStarted(payload as TurnStartedPayload, at)
      case 'model.streaming':
        return zcodeModelStreamingEvents(payload, this.openTurnKey, this.providerSessionId)
      case 'tool.updated':
        return zcodeToolUpdatedEvents(payload, this.openTurnKey, this.providerSessionId)
      case 'turn.completed':
        return this.turnCompleted(payload, at)
      case 'turn.failed':
        return this.turnFailed(payload, at)
      case 'turn.steerDrained':
        return this.steerDrained(payload, at)
      default:
        return []
    }
  }

  /** Non-event frames worth a bounded fallback row; known bookkeeping frames translate to nothing. */
  frame(kind: string, payload: unknown): ProviderTimelineEvent[] {
    if (kind === 'session.titleUpdated' || kind === 'session.updated' || this.isNoise(kind)) {
      return []
    }
    return [
      { type: 'provider.frame', frameKind: kind, payload, join: { thread: this.providerSessionId } }
    ]
  }

  /**
   * High-frequency backend chatter (telemetry, process samples, hook descriptors). Every frame
   * the assembler admits releases the open text stream, so letting these through would split the
   * reply into one journal row per delta and the settled turn would fold away all but the last.
   */
  private isNoise(kind: string): boolean {
    return (
      kind === 'state.updated' ||
      kind === 'startup/storageState' ||
      kind.startsWith('v4/') ||
      kind.startsWith('computer-use/') ||
      kind.startsWith('process/')
    )
  }

  /** Context facts from the session projection and state pushes. */
  contextUsage(usage: unknown, contextWindow: unknown, at: number): ProviderTimelineEvent[] {
    const tokens = readTokenUsage(usage)
    const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null
    if (!tokens && !window) {
      return []
    }
    const facts: AgentSessionContextUsage = {
      ...(window ? { window: { tokens: window, capturedAt: at } } : {}),
      ...(tokens ? { used: { kind: 'estimate', usage: tokens, capturedAt: at } } : {})
    }
    return [{ type: 'context.usage', usage: facts, join: { thread: this.providerSessionId } }]
  }

  private turnStarted(payload: TurnStartedPayload, at: number): ProviderTimelineEvent[] {
    const turnKey =
      readString(payload.queryId) ??
      readString(payload.foregroundExecutionId) ??
      readString(payload.messageId)
    const events: ProviderTimelineEvent[] = []
    const inputText = readString(payload.input)
    const isBackground = payload.inputSource === 'background_task'
    if (this.openTurnKey === null) {
      this.openTurnKey = turnKey
      events.push({ type: 'turn.open', ...(turnKey ? { turn: turnKey } : {}), at })
    } else if (turnKey && !isBackground) {
      this.openTurnKey = turnKey
      events.push({ type: 'turn.open', turn: turnKey, at })
    }
    if (inputText && !isBackground) {
      const turn = this.openTurnKey ?? turnKey
      const settled = this.settleMatchingSend(inputText)
      if (settled) {
        events.push({
          type: 'input.accepted',
          clientMessageId: settled,
          requestedAt: at,
          join: this.join(turn)
        })
      }
      events.push({
        type: 'item.open',
        item: readString(payload.messageId) ?? `${turn ?? this.providerSessionId}:input`,
        body: { kind: 'message', role: 'user', blocks: [textBlock(inputText)] },
        join: this.join(turn)
      })
    }
    return events
  }

  private turnCompleted(payload: unknown, at: number): ProviderTimelineEvent[] {
    const record = readRecord(payload)
    const events: ProviderTimelineEvent[] = [
      {
        type: 'turn.end',
        ...(this.openTurnKey ? { turn: this.openTurnKey } : {}),
        at,
        state: 'completed',
        outcome: record?.resultType === 'success' ? ('success' as const) : undefined,
        ...(typeof record?.durationMs === 'number' ? { durationMs: record.durationMs } : {})
      }
    ]
    const usage = readTokenUsage(record?.usage)
    if (usage) {
      events.push({
        type: 'context.usage',
        usage: { used: { kind: 'estimate', usage, capturedAt: at } },
        join: { thread: this.providerSessionId }
      })
    }
    this.openTurnKey = null
    return events
  }

  private turnFailed(payload: unknown, at: number): ProviderTimelineEvent[] {
    const record = readRecord(payload)
    const message =
      readString(readRecord(record?.error)?.message) ?? 'zcode ended this turn with an error.'
    const failure = agentSessionFailureWords(
      agentSessionFailureFact('providerRejected', {
        detail: providerDiagnostic(message, 'person')
      }),
      { surface: 'row' }
    )
    const events: ProviderTimelineEvent[] = [
      {
        type: 'item.open',
        item: `${this.openTurnKey ?? this.providerSessionId}:failure:${at}`,
        body: { kind: 'status', text: failure.text, failure: failure.failure },
        join: this.join(this.openTurnKey)
      },
      {
        type: 'turn.end',
        ...(this.openTurnKey ? { turn: this.openTurnKey } : {}),
        at,
        state: 'completed',
        outcome: 'failure'
      }
    ]
    this.openTurnKey = null
    // The failed turn carried its send to the provider; nothing is held anymore.
    this.inFlight.length = 0
    return events
  }

  private steerDrained(payload: unknown, at: number): ProviderTimelineEvent[] {
    const record = readRecord(payload)
    const drained = Array.isArray(record?.drainedInputs) ? record.drainedInputs : []
    const events: ProviderTimelineEvent[] = []
    for (const entry of drained) {
      const item = readRecord(entry)
      const text = readString(item?.text)
      if (!text) {
        continue
      }
      const settled = this.settleMatchingSend(text)
      const itemId =
        readString(item?.messageId) ?? `${this.openTurnKey ?? this.providerSessionId}:steer:${at}`
      events.push({
        type: 'item.open',
        item: itemId,
        body: { kind: 'message', role: 'user', blocks: [textBlock(text)] },
        join: this.join(this.openTurnKey)
      })
      if (settled) {
        events.push({
          type: 'input.accepted',
          clientMessageId: settled,
          requestedAt: at,
          join: this.join(this.openTurnKey)
        })
      }
    }
    return events
  }

  /** The send whose exact text this echo carries, removing it from the roster. */
  private settleMatchingSend(text: string): string | null {
    const index = this.inFlight.findIndex((send) => send.text === text)
    if (index === -1) {
      return null
    }
    const [match] = this.inFlight.splice(index, 1)
    return match!.clientMessageId
  }
}

/** Map a zcode usage object onto Orca's cache-exclusive token shape. */
function readTokenUsage(usage: unknown): AgentSessionTokenUsage | null {
  const record = readRecord(usage)
  if (!record || typeof record.totalTokens !== 'number') {
    return null
  }
  const totalInput = typeof record.inputTokens === 'number' ? record.inputTokens : 0
  const cacheRead = typeof record.cacheReadTokens === 'number' ? record.cacheReadTokens : 0
  const cacheWrite = typeof record.cacheWriteTokens === 'number' ? record.cacheWriteTokens : 0
  return {
    // zcode's inputTokens is cache-INCLUSIVE; Orca's excludes cache.
    inputTokens: Math.max(0, totalInput - cacheRead - cacheWrite),
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    outputTokens: typeof record.outputTokens === 'number' ? record.outputTokens : 0
  }
}

function textBlock(text: string): NativeChatBlock {
  return { type: 'text', text }
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

export function digestZcodePayload(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
