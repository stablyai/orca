import type { WorkerDispatchState } from './types'

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
  deadline_at: string
  max_requests: number
  watchdog_sentinel_path: string | null
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
