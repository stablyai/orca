export const JOURNAL_DOMAIN_PROFILE_TABLES: readonly {
  name: string
  columns: readonly string[]
  requiredFrom?: number
}[] = [
  { name: 'agent_session_records', columns: ['session_id', 'record_json'], requiredFrom: 4 },
  { name: 'agent_session_operations', columns: ['operation_key', 'row_json'], requiredFrom: 4 },
  { name: 'agent_session_retired_claim_keys', columns: ['key_id', 'retired_at'], requiredFrom: 4 },
  { name: 'agent_session_tabs', columns: ['tab_id', 'session_id', 'position'], requiredFrom: 4 },
  { name: 'agent_session_store_meta', columns: ['key', 'value'], requiredFrom: 4 },
  {
    name: 'agent_session_command_receipts',
    columns: [
      'operation_id',
      'session_id',
      'caller_key',
      'method',
      'fingerprint',
      'status',
      'result_json',
      'rejection_json',
      'accepted_at'
    ]
  },
  { name: 'agent_session_attachment_claims', columns: ['upload_id', 'session_id', 'claimed_at'] },
  { name: 'agent_session_attachment_sweeps', columns: ['upload_id', 'started_at'] },
  {
    name: 'pr_chat_actions',
    columns: [
      'chat_id',
      'anchor_item_id',
      'anchor_revision',
      'forge_host',
      'owner',
      'repo',
      'number',
      'kind',
      'head_sha',
      'observed_at'
    ]
  },
  {
    name: 'pr_check_events',
    columns: [
      'id',
      'pr_key',
      'head_sha',
      'occurrence',
      'verdict',
      'completed_at',
      'observed_at',
      'is_current_head'
    ]
  },
  { name: 'pr_event_deliveries', columns: ['chat_id', 'event_id', 'state', 'item_id'] },
  {
    name: 'pr_pending_heads',
    columns: ['pr_key', 'head_sha', 'first_seen_at', 'moved_at', 'expires_at']
  },
  {
    name: 'pr_pending_actions',
    columns: [
      'chat_id',
      'anchor_item_id',
      'anchor_revision',
      'evidence_json',
      'finished_at',
      'resolve_deadline_at',
      'verify_deadline_at',
      'next_attempt_at',
      'attempts'
    ]
  },
  {
    name: 'pr_check_contexts',
    columns: ['pr_key', 'head_sha', 'context', 'last_state', 'last_run_id', 'pending_seen']
  }
]
