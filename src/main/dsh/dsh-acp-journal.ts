import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AgentJournalItemIdentity,
  AgentJournalItemBody,
  AgentJournalToolCallItem,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { DshAcpStopReason, DshAcpUpdate } from './dsh-acp-session'
import {
  DSH_ACP_MESSAGE_MAX_BYTES,
  dshAcpMessageContentSchema,
  dshAcpImageBlock
} from './dsh-acp-message-content'

const toolSchema = z
  .object({
    toolCallId: z.string().min(1).max(512),
    title: z.string().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.unknown().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional()
  })
  .passthrough()

export class DshAcpJournal {
  private ordinal = 0
  private readonly tools = new Map<
    string,
    { identity: AgentJournalItemIdentity; body: AgentJournalToolCallItem }
  >()
  private stream: {
    identity: AgentJournalItemIdentity
    role: 'user' | 'assistant' | 'reasoning'
    text: string
  } | null = null
  private turn: { identity: AgentJournalItemIdentity; body: AgentJournalTurnItem } | null = null
  private readonly generation = randomUUID()

  constructor(
    private readonly providerSessionId: () => string,
    private readonly sink?: StructuredAgentSessionEventSink,
    private readonly model: () => string = () => ''
  ) {}

  private identity(_replay = false): AgentJournalItemIdentity {
    return {
      provider: 'dsh-acp',
      sessionId: this.providerSessionId(),
      recordId: `${this.generation}:${this.ordinal++}`
    }
  }

  append(identity: AgentJournalItemIdentity, body: AgentJournalItemBody, replay = false): void {
    if (!this.sink) {
      return
    }
    const options = {
      turnScope:
        body.kind === 'turn' || !this.turn || replay
          ? { kind: 'thread' as const }
          : { kind: 'turn' as const, turnItemId: agentJournalItemKey(this.turn.identity) }
    }
    if (this.sink.tryAppendItem) {
      if (!this.sink.tryAppendItem(identity, body, options).accepted) {
        throw new Error('Dsh ACP journal could not admit an event')
      }
    } else {
      this.sink.appendItem(identity, body, options)
    }
    this.sink.publish()
  }

  begin(clientMessageId: string, requestedAt?: number): AgentJournalItemIdentity {
    if (this.turn) {
      throw new Error('Dsh ACP journal already has a running turn')
    }
    this.stream = null
    this.tools.clear()
    const userIdentity: AgentJournalItemIdentity = {
      provider: 'dsh-acp',
      sessionId: this.providerSessionId(),
      recordId: `input:${clientMessageId}`
    }
    const turnId = randomUUID()
    this.turn = {
      identity: this.identity(),
      body: {
        kind: 'turn',
        turnId,
        state: 'running',
        startedAt: Date.now(),
        userItemId: agentJournalItemKey(userIdentity),
        ...(requestedAt === undefined ? {} : { requestedAt })
      }
    }
    this.append(this.turn.identity, this.turn.body)
    return userIdentity
  }

  get turnId(): string | null {
    return this.turn?.body.turnId ?? null
  }

  end(reason: DshAcpStopReason): void {
    if (!this.turn) {
      return
    }
    const turn = this.turn
    this.append(turn.identity, {
      ...turn.body,
      state: 'completed',
      completedAt: Date.now(),
      outcome:
        reason === 'cancelled' ? 'cancellation' : reason === 'end_turn' ? 'success' : 'failure'
    })
    this.turn = null
    this.stream = null
    this.tools.clear()
    this.sink?.setActivity?.(null)
  }

  update(update: DshAcpUpdate, replay: boolean): boolean {
    const kind = update.sessionUpdate
    if (
      kind === 'user_message_chunk' ||
      kind === 'agent_message_chunk' ||
      kind === 'agent_thought_chunk'
    ) {
      const content = dshAcpMessageContentSchema.parse(update.content)
      if (content.type === 'image') {
        if (kind !== 'agent_message_chunk') {
          throw new Error('Dsh ACP images must belong to assistant output')
        }
        // Separate rows preserve text/image/text order in the existing prose renderer.
        this.stream = null
        this.append(
          this.identity(replay),
          { kind: 'message', role: 'assistant', blocks: [dshAcpImageBlock(content)] },
          replay
        )
        return true
      }
      const role =
        kind === 'user_message_chunk'
          ? 'user'
          : kind === 'agent_thought_chunk'
            ? 'reasoning'
            : 'assistant'
      if (!this.stream || this.stream.role !== role || replay) {
        const echoedInput =
          role === 'user' && !replay && this.turn?.body.userItemId
            ? parseAgentJournalItemKey(this.turn.body.userItemId)
            : null
        this.stream = { identity: echoedInput ?? this.identity(replay), role, text: '' }
      }
      this.stream.text += content.text
      if (Buffer.byteLength(this.stream.text, 'utf8') > DSH_ACP_MESSAGE_MAX_BYTES) {
        throw new Error('Dsh ACP message exceeded its bounded stream')
      }
      this.append(
        this.stream.identity,
        {
          kind: 'message',
          role,
          blocks: [
            {
              type: 'text',
              text: boundInlineText(this.stream.text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
            }
          ]
        },
        replay
      )
      return true
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.stream = null
      const tool = toolSchema.parse(update)
      const previous = this.tools.get(tool.toolCallId)
      if (!previous && this.tools.size >= 1024) {
        throw new Error('Dsh ACP tool retention exceeded its bound')
      }
      if (!previous && kind === 'tool_call_update') {
        throw new Error('Dsh ACP updated an unknown tool')
      }
      const state =
        tool.status === undefined
          ? (previous?.body.state ?? 'running')
          : tool.status === 'completed'
            ? 'completed'
            : tool.status === 'failed'
              ? 'failed'
              : 'running'
      const body: AgentJournalToolCallItem = {
        kind: 'tool-call',
        name: tool.title ?? previous?.body.name ?? 'Dsh tool',
        input:
          tool.rawInput == null
            ? (previous?.body.input ?? {})
            : boundToolInput(tool.rawInput, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
        callId: tool.toolCallId,
        state,
        ...(previous?.body.output ? { output: previous.body.output } : {})
      }
      if (tool.rawOutput != null || tool.content != null) {
        body.output = boundPayload(
          JSON.stringify(tool.rawOutput ?? tool.content),
          DEFAULT_JOURNAL_PAYLOAD_LIMITS
        )
      }
      const identity = previous?.identity ?? this.identity(replay)
      this.tools.set(tool.toolCallId, { identity, body })
      this.append(identity, body, replay)
      if (!replay && this.turn) {
        this.sink?.setActivity?.({ turnId: this.turn.body.turnId, text: body.name })
      }
      return true
    }
    if (['config_option_update', 'usage_update'].includes(kind)) {
      if (kind === 'usage_update') {
        this.recordUsage(update)
      }
      return false
    }
    throw new Error(`Dsh ACP update is unsupported: ${kind}`)
  }
  private recordUsage(update: DshAcpUpdate): void {
    if (!this.turn) {
      return
    }
    const usage = z
      .object({ used: z.number().nonnegative(), size: z.number().positive() })
      .safeParse(update)
    if (!usage.success) {
      throw new Error('DSH ACP returned invalid context usage')
    }
    const capturedAt = Date.now()
    this.turn.body = {
      ...this.turn.body,
      contextUsage: {
        window: { tokens: usage.data.size, capturedAt },
        used: {
          kind: 'report',
          model: this.model(),
          usedTokens: usage.data.used,
          windowTokens: usage.data.size,
          percentage: (usage.data.used / usage.data.size) * 100,
          categories: [],
          capturedAt
        }
      }
    }
    this.append(this.turn.identity, this.turn.body)
  }
}
