export type ConversationWakeBindingStatus = 'active' | 'fenced'

export type ConversationWakeBindingRow = {
  run_id: string
  consumer_generation: number
  provider: string
  conversation_id: string
  status: ConversationWakeBindingStatus
  created_at: string
  updated_at: string
}

export type ConversationWakeJobStatus =
  | 'pending'
  | 'waiting_for_idle'
  | 'retry_wait'
  | 'submitting'
  | 'accepted'
  | 'submitted'
  | 'blocked'
  | 'blocked_inconsistent'
  | 'cancelled'
  | 'fenced'

export type ConversationWakeProvenanceSource =
  | 'current_dispatch'
  | 'current_question'
  | 'federated_dispatch'
  | 'legacy_dispatch'
  | 'legacy_question'

export type ConversationWakeProvenanceRow = {
  message_id: string
  run_id: string
  message_type: 'worker_done' | 'escalation' | 'decision_gate' | 'question'
  task_id: string
  dispatch_id: string
  source: ConversationWakeProvenanceSource
  created_at: string
}

export type ConversationWakeJobRow = {
  wake_id: string
  message_id: string
  run_id: string
  consumer_generation: number
  provider: string
  conversation_id: string
  message_type: 'worker_done' | 'escalation' | 'decision_gate' | 'question'
  task_id: string | null
  dispatch_id: string | null
  status: ConversationWakeJobStatus
  attempt_count: number
  provider_turn_id: string | null
  acceptance_lease: string | null
  lease_expires_at: number | null
  next_attempt_at: number | null
  last_error: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
}
