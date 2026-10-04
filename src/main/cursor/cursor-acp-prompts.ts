import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { ClaudePromptRegistry } from '../claude/claude-prompt-registry'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CursorAcpConnection, CursorAcpHandlers } from './cursor-acp-connection'
import { presentRequest, type Presentation } from './cursor-acp-prompt-presentation'

export class CursorAcpPrompts {
  private readonly claims = new ClaudePromptRegistry()
  private readonly presentations = new Map<string, Presentation>()
  private cancellationSignal: AbortSignal | null = null
  private readonly cancelPermissions = (): void => {
    let failed = false
    for (const [itemId, presentation] of this.presentations) {
      if (!presentation.cancel) {
        continue
      }
      const found = this.claims.find(itemId)
      if (!found || !this.claims.cancel(found.prompt.requestId)) {
        continue
      }
      this.presentations.delete(itemId)
      try {
        const identity = parseAgentJournalItemKey(itemId)
        const body = cancelledJournalPromptBody(presentation.body)
        if (identity && body) {
          this.append(identity, body)
        }
      } catch {
        failed = true
      } finally {
        presentation.cancel()
      }
    }
    if (failed) {
      void this.connection().close()
    }
  }

  constructor(
    private readonly connection: () => CursorAcpConnection,
    private readonly sessionId: () => string,
    private readonly append: (
      identity: AgentJournalItemIdentity,
      body: Presentation['body']
    ) => void
  ) {}

  receive(request: Parameters<NonNullable<CursorAcpHandlers['onServerRequest']>>[0]): boolean {
    if (
      !['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(
        request.method
      )
    ) {
      this.connection().respondWithError(
        request.id,
        -32601,
        'Orca does not implement this ACP client request'
      )
      return false
    }
    let presentation: Presentation
    try {
      if (Buffer.byteLength(JSON.stringify(request.params), 'utf8') > 256 * 1024) {
        throw new Error('Cursor ACP prompt exceeded its byte bound')
      }
      presentation = presentRequest(request.method, request.params, this.sessionId())
      if (
        new Set(presentation.body.options.map((option) => option.id)).size !==
        presentation.body.options.length
      ) {
        throw new Error('Cursor ACP prompt repeated option identities')
      }
      if (presentation.body.kind === 'question' && presentation.body.questions) {
        const questions = presentation.body.questions
        if (
          new Set(questions.map((question) => question.id)).size !== questions.length ||
          questions.some(
            (question) =>
              new Set(question.options.map((option) => option.id)).size !== question.options.length
          )
        ) {
          throw new Error('Cursor ACP question repeated identities')
        }
      }
    } catch {
      this.connection().respondWithError(
        request.id,
        -32602,
        'Cursor ACP prompt is malformed or belongs to another session'
      )
      return false
    }
    if (request.method === 'session/request_permission') {
      const signal = this.connection().permissionCancellation.signal
      if (signal.aborted) {
        this.connection().respond(request.id, { outcome: { outcome: 'cancelled' } })
        return false
      }
      if (this.cancellationSignal !== signal) {
        this.cancellationSignal?.removeEventListener('abort', this.cancelPermissions)
        this.cancellationSignal = signal
        signal.addEventListener('abort', this.cancelPermissions, { once: true })
      }
    }
    if (this.presentations.size >= 64) {
      throw new Error('Cursor ACP pending prompt limit exceeded')
    }
    const key = randomUUID()
    const identity: AgentJournalItemIdentity = {
      provider: 'cursor',
      sessionId: this.sessionId(),
      recordId: `prompt:${key}`
    }
    const itemId = agentJournalItemKey(identity)
    const prompt = this.claims.register({
      requestId: key,
      toolName: presentation.body.kind === 'question' ? 'AskUserQuestion' : 'Cursor approval',
      toolUseId: key,
      input:
        presentation.body.kind === 'question' ? { questions: presentation.body.questions } : {},
      suggestions: [],
      settle: () => undefined
    })
    if (!prompt) {
      throw new Error('Cursor ACP could not retain its pending prompt')
    }
    const reply = presentation.reply
    this.presentations.set(itemId, {
      ...presentation,
      ...(request.method === 'session/request_permission'
        ? {
            cancel: () =>
              this.connection().respond(request.id, { outcome: { outcome: 'cancelled' } })
          }
        : {}),
      reply: (response) => ({ id: request.id, result: reply(response) })
    })
    this.claims.bindJournalItemId(itemId, key)
    this.append(identity, presentation.body)
    return true
  }

  async answer(input: Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]): Promise<void> {
    const claim = this.claims.claim(input.itemId, input.kind)
    const presentation = this.presentations.get(input.itemId)
    if (!claim || !presentation) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    try {
      const response = z
        .object({ id: z.union([z.string(), z.number()]), result: z.unknown() })
        .parse(presentation.reply(input.response))
      if (this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      await input.commit()
      if (!this.claims.ownsClaim(claim) || this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      this.claims.forget(claim.found.prompt)
      this.presentations.delete(input.itemId)
      this.connection().respond(response.id, response.result)
    } finally {
      this.claims.releaseClaim(claim)
    }
  }

  clear(): void {
    this.cancellationSignal?.removeEventListener('abort', this.cancelPermissions)
    this.cancellationSignal = null
    this.claims.clear()
    this.presentations.clear()
  }
}
