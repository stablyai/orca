import { randomUUID } from 'node:crypto'
import type {
  ConversationWakeTurnRequest,
  ConversationWakeTurnResult
} from '../runtime/orchestration/conversation-wake-provider'
import type { CodexControlledSessionStateStore } from './codex-controlled-session-state'
import type { CodexUnixAppServerClient } from './codex-unix-app-server-client'

type FinalizerSession = {
  threadId: string
  client: CodexUnixAppServerClient
  state: CodexControlledSessionStateStore
}

export class CodexControlledTurnFinalizer {
  constructor(
    private readonly session: FinalizerSession,
    private readonly isEnabled: () => boolean
  ) {}

  async prepareAndFinalize(
    request: ConversationWakeTurnRequest
  ): Promise<ConversationWakeTurnResult> {
    this.assertEnabled()
    const prior = this.session.state.get(request.idempotencyKey)
    if (prior) {
      return this.resumePrepared(request, prior)
    }
    if (request.acceptedTurnId) {
      return { status: 'stale' }
    }
    const operationId = randomUUID()
    const record = {
      operationId,
      clientMessageId: operationId,
      prompt: request.prompt,
      phase: 'prepared' as const,
      codexTurnId: null
    }
    this.session.state.put(request.idempotencyKey, record)
    if (!request.commitPrepared(operationId)) {
      this.session.state.put(request.idempotencyKey, { ...record, phase: 'rejected' })
      return { status: 'stale' }
    }
    const accepted = { ...record, phase: 'accepted' as const }
    this.session.state.put(request.idempotencyKey, accepted)
    return this.startAccepted(request, accepted)
  }

  private async resumePrepared(
    request: ConversationWakeTurnRequest,
    prior: NonNullable<ReturnType<CodexControlledSessionStateStore['get']>>
  ): Promise<ConversationWakeTurnResult> {
    if (
      prior.prompt !== request.prompt ||
      (request.acceptedTurnId && request.acceptedTurnId !== prior.operationId)
    ) {
      throw new Error('controlled Codex idempotency record mismatch')
    }
    if (prior.phase === 'rejected') {
      return { status: 'stale' }
    }
    if (prior.phase === 'prepared') {
      if (
        request.acceptedTurnId !== prior.operationId &&
        !request.commitPrepared(prior.operationId)
      ) {
        return { status: 'stale' }
      }
      prior = { ...prior, phase: 'accepted' }
      this.session.state.put(request.idempotencyKey, prior)
    }
    if (prior.phase === 'finalized') {
      return { status: 'finalized', turnId: prior.operationId, duplicate: true }
    }
    return this.startAccepted(request, prior)
  }

  private async startAccepted(
    request: ConversationWakeTurnRequest,
    record: NonNullable<ReturnType<CodexControlledSessionStateStore['get']>>
  ): Promise<ConversationWakeTurnResult> {
    this.assertEnabled()
    const reconciled = await this.findTurn(record.clientMessageId)
    if (reconciled) {
      this.finalizeRecord(request, record, reconciled)
      return { status: 'finalized', turnId: record.operationId, duplicate: true }
    }
    if (record.phase === 'ambiguous') {
      throw new Error('controlled Codex turn start remains ambiguous')
    }
    this.assertEnabled()
    try {
      const response = await this.session.client.request('turn/start', {
        threadId: this.session.threadId,
        clientUserMessageId: record.clientMessageId,
        input: [{ type: 'text', text: record.prompt, text_elements: [] }]
      })
      this.finalizeRecord(request, record, extractTurnId(response))
      return { status: 'finalized', turnId: record.operationId, duplicate: false }
    } catch (error) {
      this.session.state.put(request.idempotencyKey, { ...record, phase: 'ambiguous' })
      const afterFailure = await this.findTurn(record.clientMessageId)
      if (!afterFailure) {
        throw error
      }
      this.finalizeRecord(request, record, afterFailure)
      return { status: 'finalized', turnId: record.operationId, duplicate: true }
    }
  }

  private async findTurn(clientMessageId: string): Promise<string | null> {
    const response = await this.session.client.request('thread/read', {
      threadId: this.session.threadId,
      includeTurns: true
    })
    const turns = isRecord(response) && isRecord(response.thread) ? response.thread.turns : null
    if (!Array.isArray(turns)) {
      return null
    }
    for (const turn of turns) {
      if (!isRecord(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
        continue
      }
      const matched = turn.items.some(
        (item) => isRecord(item) && item.type === 'userMessage' && item.clientId === clientMessageId
      )
      if (matched) {
        return turn.id
      }
    }
    return null
  }

  private finalizeRecord(
    request: ConversationWakeTurnRequest,
    record: NonNullable<ReturnType<CodexControlledSessionStateStore['get']>>,
    codexTurnId: string
  ): void {
    this.session.state.put(request.idempotencyKey, {
      ...record,
      phase: 'finalized',
      codexTurnId
    })
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error('controlled Codex wake is disabled')
    }
  }
}

function extractTurnId(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.turn) || typeof response.turn.id !== 'string') {
    throw new Error('controlled Codex turn/start returned an invalid response')
  }
  return response.turn.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
