import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalToolCallItem,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { writeAgentJournalTurnRow } from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import {
  boundInlineText,
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CursorSidecarEvent } from './cursor-sdk-protocol'

export type CursorTurn = {
  sessionId: string
  turnId: string
  startedAt: number
  requestedAt?: number
}

type LiveText = { assistant: string; thinking: string }

export function cursorTurnIdentity(sessionId: string, turnId: string): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'cursor', sessionId, recordId: `turn:${turnId}` }
}

export function cursorItemIdentity(sessionId: string, recordId: string): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'cursor', sessionId, recordId }
}

export class CursorJournalTranslator {
  private readonly text = new Map<string, LiveText>()
  private readonly contextByTurn = new Map<string, AgentSessionContextUsage>()
  private readonly settled = new Map<
    string,
    {
      state: 'completed' | 'interrupted'
      outcome: 'failure' | 'cancellation' | 'success'
      completedAt: number
      durationMs?: number
    }
  >()
  private contextWindowTokens: number | null = null
  private loginShown = false

  setContextWindowTokens(tokens: number | null): void {
    this.contextWindowTokens = tokens
  }

  constructor(
    private readonly sessionId: string,
    private readonly events: StructuredAgentSessionEventSink | undefined
  ) {}

  openTurn(turn: CursorTurn): void {
    this.text.set(turn.turnId, { assistant: '', thinking: '' })
    this.writeTurn(turn, turn.startedAt)
  }

  apply(turn: CursorTurn, event: CursorSidecarEvent): void {
    const live = this.text.get(turn.turnId) ?? { assistant: '', thinking: '' }
    this.text.set(turn.turnId, live)
    const scope = {
      kind: 'turn' as const,
      turnItemId: agentJournalItemKey(cursorTurnIdentity(this.sessionId, turn.turnId))
    }
    if (event.type === 'text') {
      live.assistant += event.text
      this.write(
        cursorItemIdentity(this.sessionId, `assistant:${turn.turnId}`),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: boundText(live.assistant) }]
        },
        scope
      )
      return
    }
    if (event.type === 'thinking') {
      live.thinking += event.text
      this.write(
        cursorItemIdentity(this.sessionId, `thinking:${turn.turnId}`),
        {
          kind: 'message',
          role: 'reasoning',
          blocks: [{ type: 'text', text: boundText(live.thinking) }]
        },
        scope
      )
      return
    }
    if (event.type === 'task') {
      this.write(
        cursorItemIdentity(this.sessionId, `task:${turn.turnId}`),
        { kind: 'status', text: event.text },
        scope
      )
      return
    }
    if (event.type === 'tool') {
      const output = event.result === undefined ? undefined : boundToolResult(event.result)
      const body: AgentJournalToolCallItem = {
        kind: 'tool-call',
        name: event.name,
        input: boundToolInput(event.args ?? null, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
        callId: event.callId,
        state:
          event.status === 'error'
            ? 'failed'
            : event.status === 'completed'
              ? 'completed'
              : 'running',
        ...(output ? { output } : {})
      }
      this.write(cursorItemIdentity(this.sessionId, `tool:${event.callId}`), body, scope)
      return
    }
    if (event.type === 'usage') {
      const capturedAt = Date.now()
      const windowTokens = this.contextWindowTokens
      this.contextByTurn.set(turn.turnId, {
        used: {
          kind: 'estimate',
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheCreationInputTokens: event.cacheWriteTokens,
            cacheReadInputTokens: event.cacheReadTokens
          },
          capturedAt
        },
        ...(windowTokens ? { window: { tokens: windowTokens, capturedAt } } : {})
      })
      this.writeTurn(turn)
      return
    }
    if (event.type === 'result') {
      if (!live.assistant && event.result) {
        this.write(
          cursorItemIdentity(this.sessionId, `assistant:${turn.turnId}`),
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: boundText(event.result) }]
          },
          scope
        )
      }
      const failed = event.status === 'error'
      const interrupted = event.status === 'cancelled'
      this.settled.set(turn.turnId, {
        state: interrupted ? 'interrupted' : 'completed',
        outcome: failed ? 'failure' : interrupted ? 'cancellation' : 'success',
        completedAt: Date.now(),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
      })
      this.writeTurn(turn)
    }
  }

  private writeTurn(turn: CursorTurn, observedAt?: number): void {
    const events = this.events
    if (!events) {
      return
    }
    const contextUsage = this.contextByTurn.get(turn.turnId)
    writeAgentJournalTurnRow(
      events,
      { identity: cursorTurnIdentity(this.sessionId, turn.turnId) },
      { lifecycle: this.turnLifecycle(turn), ...(contextUsage ? { contextUsage } : {}) },
      { publish: true, ...(observedAt === undefined ? {} : { options: { observedAt } }) }
    )
  }

  private turnLifecycle(turn: CursorTurn): AgentJournalTurnItem {
    const done = this.settled.get(turn.turnId)
    const contextUsage = this.contextByTurn.get(turn.turnId)
    return agentJournalTurnBody({
      turnId: turn.turnId,
      state: done?.state ?? 'running',
      ...(done ? { outcome: done.outcome, completedAt: done.completedAt } : {}),
      startedAt: turn.startedAt,
      ...(turn.requestedAt === undefined ? {} : { requestedAt: turn.requestedAt }),
      userItemId: agentJournalSubmissionKey(turn.turnId),
      ...(done?.durationMs === undefined ? {} : { durationMs: done.durationMs }),
      ...(contextUsage ? { contextUsage } : {})
    })
  }

  loginUrl(url: string): void {
    this.loginShown = true
    this.write(
      cursorItemIdentity(this.sessionId, 'login-url'),
      { kind: 'status', text: `Sign in to Cursor to continue: ${url}` },
      AGENT_JOURNAL_THREAD_SCOPE
    )
  }

  clearLogin(): void {
    if (!this.loginShown) {
      return
    }
    this.loginShown = false
    this.events?.appendTombstone(cursorItemIdentity(this.sessionId, 'login-url'))
    this.events?.publish()
  }

  private write(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope: { kind: 'turn'; turnItemId: string } | typeof AGENT_JOURNAL_THREAD_SCOPE,
    extra?: { observedAt?: number }
  ): void {
    this.events?.appendItem(identity, body, {
      turnScope,
      ...(extra?.observedAt === undefined ? {} : { observedAt: extra.observedAt })
    })
    this.events?.publish()
  }
}

function boundText(text: string): string {
  return boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
}

function boundToolResult(value: unknown): AgentJournalToolCallItem['output'] {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return boundPayload(raw ?? 'null', DEFAULT_JOURNAL_PAYLOAD_LIMITS)
}
