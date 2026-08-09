export const MESSAGE_TYPES = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'question',
  'heartbeat'
] as const

export type MessageType = (typeof MESSAGE_TYPES)[number]

export type MessagePriority = 'normal' | 'high' | 'urgent'

export type MessageDeliveryContract = 'legacy_direct' | 'current_delivery' | 'audit_only'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'

export type DispatchStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'circuit_broken'

export type WorkerReportOutcome = 'succeeded' | 'failed'

export type WorkerReportSettlement =
  | { action: 'settled'; outcome: WorkerReportOutcome; duplicate: boolean }
  | {
      action: 'rejected'
      code:
        | 'unknown_task'
        | 'unknown_dispatch'
        | 'task_dispatch_mismatch'
        | 'inactive_dispatch'
        | 'stale_dispatch'
      reason: string
    }

export type GateStatus = 'pending' | 'resolved' | 'timeout'

export type CoordinatorStatus = 'idle' | 'running' | 'completed' | 'failed'

export type RunRow = {
  id: string
  objective: string
  home_database: string
  coordinator_handle: string | null
  coordinator_pane_key: string | null
  consumer_generation: number
  legacy: number
  created_at: string
  updated_at: string
}

export type DeliveryStatus = 'outstanding' | 'acknowledged' | 'fenced'

export type DeliveryRow = {
  id: string
  run_id: string
  consumer_generation: number
  message_ids: string
  status: DeliveryStatus
  created_at: string
  acknowledged_at: string | null
}

export type LegacyAdoptionRow = {
  source_run_id: string
  adopted_run_id: string
  scheduler_state_lost: number
  adopted_at: string
}

export type LegacyPrincipalRole = 'worker' | 'coordinator'

export type LegacyPrincipalStatus = 'committed' | 'settled' | 'revoked'

export type LegacyCompatibilityPrincipalRow = {
  id: string
  run_id: string
  dispatch_id: string | null
  role: LegacyPrincipalRole
  host_scope: string
  terminal_handle: string
  pane_key: string
  launch_token_hash: string
  process_incarnation: string | null
  status: LegacyPrincipalStatus
}

export type LegacyOperationReceiptRow = {
  principal_id: string
  operation_key: string
  method: string
  payload_hash: string
  effect_id: string
  response_json: string
  completed_at: string
}

export type LegacyMailReceiptRow = {
  principal_id: string
  message_id: string
  acknowledged_at: string | null
}

export type QuestionStatus = 'pending' | 'answered' | 'closed'

export type QuestionRow = {
  message_id: string
  run_id: string
  dispatch_id: string
  asker_handle: string
  status: QuestionStatus
  answer_message_id: string | null
  answer_body: string | null
  answered_by_generation: number | null
  created_at: string
  answered_at: string | null
  closed_at: string | null
}

export type MutationState = 'pending' | 'completed'

export type MutationReceiptRow = {
  caller_fingerprint: string
  request_id: string
  method: string
  payload_hash: string
  state: MutationState
  receipt: string | null
  created_at: string
  updated_at: string
}

export type WorkerDispatchState =
  | 'starting'
  | 'ready'
  | 'start_unknown'
  | 'failed'
  | 'succeeded'
  | 'stopping'
  | 'stop_unknown'
  | 'stopped'
  | 'abandoned'

export type WorkerDispatchRow = {
  dispatch_id: string
  runtime_epoch: string | null
  state: WorkerDispatchState
  stage: string
  worktree_id: string | null
  agent_terminal_handle: string | null
  setup_state: string
  effects: string
  residual_resources: string
  start_options: string
  last_error: string | null
  created_at: string
  updated_at: string
}

export type LegacyWorkerTerminalRecoveryRow = {
  dispatch_id: string
  task_id: string
  dispatch_status: DispatchStatus
  contract_version: number
  assignee_handle: string | null
  assignee_pane_key: string | null
  process_incarnation: string | null
  worker_state: WorkerDispatchState
  worktree_id: string | null
  agent_terminal_handle: string | null
}

export type FederatedDispatchRow = {
  dispatch_id: string
  environment_id: string
  environment_name: string
  peer_fingerprint: string
  remote_runtime_epoch: string | null
  protocol_version: number
  remote_worktree_id: string | null
  remote_terminal_handle: string | null
  to_home_imported_sequence: number
  created_at: string
  updated_at: string
}

export type RemoteDispatchAttachmentRow = {
  dispatch_id: string
  task_id: string
  home_peer_fingerprint: string
  protocol_version: number
  runtime_epoch: string
  capability_hash: string | null
  pane_key: string | null
  process_incarnation: string | null
  state: WorkerDispatchState
  stage: string
  worktree_id: string | null
  terminal_handle: string | null
  setup_state: string
  effects: string
  residual_resources: string
  to_worker_imported_sequence: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export type FederationRelayDirection = 'to_home' | 'to_worker'

export type FederationRelayItemRow = {
  dispatch_id: string
  direction: FederationRelayDirection
  sequence: number
  message_id: string
  kind: string
  payload: string
  byte_count: number
  acked_at: string | null
  created_at: string
}

export type MessageRow = {
  id: string
  run_id: string
  delivery_contract?: MessageDeliveryContract
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: string | null
}

export type TaskRow = {
  id: string
  run_id: string
  parent_id: string | null
  created_by_terminal_handle: string | null
  created_by_pane_key: string | null
  created_by_process_incarnation: string | null
  created_by_run_generation: number | null
  task_title: string | null
  display_name: string | null
  spec: string
  status: TaskStatus
  deps: string
  result: string | null
  created_at: string
  completed_at: string | null
}

export type DispatchContextRow = {
  id: string
  run_id: string
  task_id: string
  contract_version: number
  launch_token_hash: string | null
  assignee_handle: string | null
  assignee_pane_key: string | null
  capability_hash: string | null
  process_incarnation: string | null
  capability_revoked_at: string | null
  status: DispatchStatus
  failure_count: number
  last_failure: string | null
  dispatched_at: string | null
  completed_at: string | null
  created_at: string
  last_heartbeat_at: string | null
}

export type DecisionGateRow = {
  id: string
  run_id: string
  task_id: string
  question: string
  options: string
  status: GateStatus
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

export type CoordinatorRun = {
  id: string
  spec: string
  status: CoordinatorStatus
  coordinator_handle: string
  poll_interval_ms: number
  created_at: string
  completed_at: string | null
  scheduler_lost_at: string | null
}
