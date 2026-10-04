import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { ClaudePromptRegistry } from '../claude/claude-prompt-registry'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { DshAcpConnection, DshAcpHandlers } from './dsh-acp-connection'

const permission = z.object({
  sessionId: z.string().min(1).max(512),
  toolCall: z.object({
    toolCallId: z.string().min(1).max(512),
    title: z.string().max(4096).optional()
  }),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1).max(512),
        name: z.string().max(512),
        kind: z.enum(['allow_once', 'reject_once'])
      })
    )
    .min(1)
    .max(8)
})
type Pending = {
  id: string | number
  identity: AgentJournalItemIdentity
  body: AgentJournalApprovalItem
}

export class DshAcpPrompts {
  private readonly claims = new ClaudePromptRegistry()
  private readonly pending = new Map<string, Pending>()
  private signal: AbortSignal | null = null
  private readonly cancel = (): void => {
    for (const [itemId, prompt] of this.pending) {
      const found = this.claims.find(itemId)
      if (!found || !this.claims.cancel(found.prompt.requestId)) {
        continue
      }
      this.pending.delete(itemId)
      try {
        const body = cancelledJournalPromptBody(prompt.body)
        if (body?.kind === 'approval') {
          this.append(prompt.identity, body)
        }
      } finally {
        this.connection().respond(prompt.id, { outcome: { outcome: 'cancelled' } })
      }
    }
  }
  constructor(
    private readonly connection: () => DshAcpConnection,
    private readonly sessionId: () => string,
    private readonly append: (
      identity: AgentJournalItemIdentity,
      body: AgentJournalApprovalItem
    ) => void
  ) {}
  receive(request: Parameters<NonNullable<DshAcpHandlers['onServerRequest']>>[0]): boolean {
    if (request.method !== 'session/request_permission') {
      this.connection().respondWithError(
        request.id,
        -32601,
        'This ACP client request is unsupported'
      )
      return false
    }
    const parsed = permission.safeParse(request.params)
    if (
      !parsed.success ||
      parsed.data.sessionId !== this.sessionId() ||
      new Set(parsed.data.options.map((option) => option.optionId)).size !==
        parsed.data.options.length
    ) {
      this.connection().respondWithError(
        request.id,
        -32602,
        'Permission request does not match the owned session or one-shot choices'
      )
      return false
    }
    const signal = this.connection().permissionCancellation.signal
    if (signal.aborted) {
      this.connection().respond(request.id, { outcome: { outcome: 'cancelled' } })
      return false
    }
    if (this.signal !== signal) {
      this.signal?.removeEventListener('abort', this.cancel)
      this.signal = signal
      signal.addEventListener('abort', this.cancel, { once: true })
    }
    if ([...this.pending.values()].some((prompt) => prompt.id === request.id)) {
      throw new Error('DeepSeek Harness repeated an outstanding permission request id')
    }
    if (this.pending.size >= 64) {
      throw new Error('DSH ACP pending permissions exceeded their bound')
    }
    const key = randomUUID()
    const identity: AgentJournalItemIdentity = {
      provider: 'dsh-acp',
      sessionId: this.sessionId(),
      recordId: `permission:${key}`
    }
    const body: AgentJournalApprovalItem = {
      kind: 'approval',
      title: parsed.data.toolCall.title ?? 'DeepSeek Harness tool permission',
      detail: parsed.data.toolCall.toolCallId,
      options: parsed.data.options.map((option) => ({ id: option.optionId, label: option.name })),
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
    const itemId = agentJournalItemKey(identity)
    this.claims.register({
      requestId: key,
      toolUseId: parsed.data.toolCall.toolCallId,
      toolName: 'DSH tool permission',
      input: {},
      suggestions: [],
      settle: () => undefined
    })
    this.claims.bindJournalItemId(itemId, key)
    this.pending.set(itemId, { id: request.id, identity, body })
    this.append(identity, body)
    return true
  }
  async answer(input: Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]): Promise<void> {
    const claim = this.claims.claim(input.itemId, input.kind)
    const prompt = this.pending.get(input.itemId)
    if (!claim || !prompt) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    try {
      const response = input.response
      if (
        response.kind !== 'option' ||
        !prompt.body.options.some((option) => option.id === response.optionId)
      ) {
        throw new AgentSessionPromptAnswerRejectedError(
          'Select a permission choice offered by DeepSeek Harness'
        )
      }
      if (this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      await input.commit()
      if (!this.claims.ownsClaim(claim) || this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      this.claims.forget(claim.found.prompt)
      this.pending.delete(input.itemId)
      this.connection().respond(prompt.id, {
        outcome: { outcome: 'selected', optionId: response.optionId }
      })
    } finally {
      this.claims.releaseClaim(claim)
    }
  }
  clear(): void {
    this.signal?.removeEventListener('abort', this.cancel)
    this.signal = null
    this.claims.clear()
    this.pending.clear()
  }
}
