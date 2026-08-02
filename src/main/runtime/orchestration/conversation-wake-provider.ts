export type ConversationWakeTarget = {
  runId: string
  consumerGeneration: number
  conversationId: string
}

export type ConversationWakeProviderState =
  | 'idle'
  | 'active'
  | 'missing'
  | 'unsupported'
  | 'unknown'

export type ConversationWakeTurnRequest = ConversationWakeTarget & {
  wakeId: string
  idempotencyKey: string
  messageId: string
  messageType: 'worker_done' | 'escalation' | 'decision_gate' | 'question'
  taskId: string | null
  dispatchId: string | null
  prompt: string
  acceptedTurnId: string | null
  /** Call only after durably preparing this exact idempotent turn. */
  commitPrepared: (providerTurnId: string) => boolean
}

export type ConversationWakeTurnResult =
  | { status: 'finalized'; turnId: string; duplicate: boolean }
  | { status: 'stale' }

export type ConversationWakeProvider = {
  readonly id: string
  getState(target: ConversationWakeTarget): Promise<ConversationWakeProviderState>
  /**
   * Serialize by conversation and durably prepare before commitPrepared. After it returns true,
   * the provider must recover and finalize the same turn across crashes. acceptedTurnId requests
   * recover that preparation and must never create a different turn.
   */
  prepareAndFinalizeTurn(request: ConversationWakeTurnRequest): Promise<ConversationWakeTurnResult>
  onTurnTerminal(listener: (conversationId: string) => void): () => void
  reconcile?(): Promise<void>
  dispose?(): void | Promise<void>
}
