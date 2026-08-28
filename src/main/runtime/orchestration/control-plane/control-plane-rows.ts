/** The persisted row shapes of the control plane.
 *
 *  Pure type declarations, split from the store so the store file is the
 *  statements and these are the schema. Re-exported by the store, so every
 *  existing import keeps working.
 */

export type OutcomeRow = {
  outcome_id: string
  run_id: string
  title: string
  fingerprint: string
  intake_batch: string | null
  status: 'admitted' | 'closed'
  gate_policy: 'standard' | 'high_risk'
  created_at: string
}

export type GateExecutionRow = {
  execution_id: string
  scope_key: string
  gate_id: string
  final_sha: string
  command: string
  exit_code: number | null
  log_digest: string
  build_id: string
  started_at: string
  finished_at: string
}

/** Immutable gate meaning supplied by the outcome manifest before a worker is
 * launched. The runtime executes this record; a worker may name `gate_id`, but
 * it cannot replace the command or dependency set behind that name. */
export type RequiredGateSpecRow = {
  outcome_id: string
  gate_id: string
  program: string
  args_json: string
  dependencies_json: string
  policy_version: string
  command_identity: string
  sha_binding: 'content' | 'exact_head'
  spec_hash: string
}

/** Runtime-owned binding for one actual gate process. Kept in an additive
 * companion table so existing Orca databases upgrade without rewriting the
 * historical execution ledger. */
export type GateExecutionAuthorityRow = {
  execution_id: string
  run_id: string
  outcome_id: string
  dispatch_id: string
  worktree_id: string
  build_id: string
  policy_version: string
  command_identity: string
  spec_hash: string
  input_hashes: string
}

export type OutcomeRelationRow = {
  left_outcome_id: string
  right_outcome_id: string
  kind: 'semantic_overlap' | 'resource_collision'
  decision: 'independent' | 'serialize' | 'merge'
  rationale: string
}

export type LivenessMarkerRow = {
  dispatch_id: string
  verdict: 'live' | 'unverifiable' | 'exited'
  activity: 'working' | 'blocked_on_approved_wait' | 'stalled' | 'crashed' | 'settled'
  reason: string
  observed_at: string
  expires_at: string
  epoch: string | null
  woke_for: string | null
  terminal: number
}

export type GateReceiptRow = {
  receipt_id: string
  scope_key: string
  gate_id: string
  final_sha: string
  input_hashes: string
  policy_version: string
  command_identity: string
  result: 'PASS' | 'FAIL'
  recorded_at: string
}

export type ValidationLeaseRow = {
  scope_key: string
  lease_id: string
  owner: string
  idempotency_key: string
  acquired_at: string
  expires_at: string
  released_at: string | null
}

export type ValidationLeaseAuthorityRow = {
  scope_key: string
  lease_id: string
  run_id: string
  outcome_id: string
  task_id: string
  dispatch_id: string
  worktree_id: string
  owner_handle: string
  owner_pane_key: string
  process_incarnation: string
  launch_token_hash: string
  runtime_id: string
  build_id: string
  expires_at: string
}

/** Thin typed accessor over the additive control-plane tables. Every method is
 *  a single statement; the transaction boundary belongs to the caller so a
 *  multi-row admission stays atomic with the orchestration write it guards. */
