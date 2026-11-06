import type { JournalSqlPrimitiveTable } from './journal-sql-primitive-facts'

const FACTS = {
  '@handles:provider-inputs': {
    table: 'journal_proj_provider_input_groups',
    id: 'provider_item_id',
    value: 'provider_item_id',
    counter: 'provider_input_groups'
  },
  '@handles:dispatch-by-fence': {
    table: 'journal_proj_dispatch_fence_groups',
    id: 'fence',
    value: 'fence',
    counter: 'dispatch_fence_groups'
  },
  '@handles:signed-out-members': {
    table: 'journal_proj_signed_out_groups',
    id: 'fence',
    value: 'fence',
    counter: 'signed_out_groups'
  },
  '@handles:kept-card-members': {
    table: 'journal_proj_kept_card_groups',
    id: 'message_id',
    value: 'message_id',
    counter: 'kept_card_groups'
  },
  '@handles:steers': {
    table: 'journal_proj_steer_groups',
    id: 'turn_id',
    value: 'turn_id',
    counter: 'steer_groups'
  },
  '@handles:carrier-coverers': {
    table: 'journal_proj_coverage_groups',
    id: 'input_id',
    value: 'input_id',
    counter: 'coverage_groups'
  },
  '@handles:link-family': {
    table: 'journal_proj_link_families',
    id: 'family_id',
    value: 'family_id',
    counter: 'link_families'
  },
  'queue.returnedCommands': {
    table: 'journal_proj_returned_commands',
    id: 'message_id',
    value: 'message_id',
    counter: 'returned_commands'
  },
  'inputs.echoes': {
    table: 'journal_proj_input_echoes',
    id: 'input_id',
    value: 'input_id',
    counter: 'input_echoes'
  },
  'inputs.ended': {
    table: 'journal_proj_ended_inputs',
    id: 'input_id',
    value: 'input_id',
    counter: 'ended_inputs'
  },
  'order.recoveryOwed': {
    table: 'journal_proj_recovery_owed',
    id: 'input_id',
    value: 'input_id',
    counter: 'recovery_owed'
  },
  'cards.unintroduced': {
    table: 'journal_proj_unintroduced_cards',
    id: 'message_id',
    value: 'message_id',
    counter: 'unintroduced_cards'
  },
  'cards.cleared': {
    table: 'journal_proj_cleared_cards',
    id: 'message_id',
    value: 'message_id',
    counter: 'cleared_cards'
  },
  'observations.providerByInput': {
    table: 'journal_proj_input_providers',
    id: 'input_id',
    value: 'provider_item_id',
    counter: 'input_providers'
  },
  'observations.inputIds': {
    table: 'journal_proj_observed_input_ids',
    id: 'item_key',
    value: 'input_id',
    counter: 'observed_input_ids'
  },
  'observations.fences': {
    table: 'journal_proj_input_dispatch_fences',
    id: 'input_id',
    value: 'fence',
    counter: 'input_dispatch_fences'
  },
  'observations.recoveredUnknown': {
    table: 'journal_proj_recovered_unknown_inputs',
    id: 'input_id',
    value: 'input_id',
    counter: 'recovered_unknown_inputs'
  },
  'evidence.submissionRows': {
    table: 'journal_proj_submission_row_winners',
    id: 'sequence',
    value: 'input_id',
    counter: 'submission_row_winners'
  },
  'evidence.rowsBySubmission': {
    table: 'journal_proj_submission_row_coordinates',
    id: 'input_id',
    value: 'sequence',
    counter: 'submission_row_coordinates'
  },
  'evidence.keptBySubmission': {
    table: 'journal_proj_kept_input_cards',
    id: 'input_id',
    value: 'message_id',
    counter: 'kept_input_cards'
  },
  'evidence.ordinals': {
    table: 'journal_proj_input_ordinals',
    id: 'input_id',
    value: 'input_ordinal',
    counter: 'input_ordinals'
  },
  'evidence.steerTurns': {
    table: 'journal_proj_steer_turns',
    id: 'input_id',
    value: 'turn_id',
    counter: 'steer_turns'
  },
  'evidence.stoppedCandidates': {
    table: 'journal_proj_stopped_candidates',
    id: 'input_id',
    value: 'input_id',
    counter: 'stopped_candidates'
  },
  'links.latest': {
    table: 'journal_proj_latest_family_members',
    id: 'family_id',
    value: 'input_id',
    counter: 'latest_family_members'
  },
  'newest-turn.evidence': {
    table: 'journal_proj_turn_failure_reports',
    id: 'item_id',
    value: 'target_item_id',
    counter: 'turn_failure_reports'
  },
  'newest-turn.reports': {
    table: 'journal_proj_turn_failure_report_counts',
    id: 'target_item_id',
    value: 'report_count',
    counter: 'turn_failure_report_counts'
  },
  aliases: { table: 'journal_proj_aliases', id: 'alias', value: 'target', counter: 'aliases' },
  itemFences: {
    table: 'journal_proj_item_fences',
    id: 'item_id',
    value: 'fence',
    counter: 'item_fences'
  },
  itemExecutionOwners: {
    table: 'journal_proj_item_execution_owners',
    id: 'item_id',
    value: 'fence',
    counter: 'execution_owners'
  },
  providerActivityAt: {
    table: 'journal_proj_provider_activity',
    id: 'fence',
    value: 'observed_at',
    counter: 'provider_activity'
  },
  tombstones: {
    table: 'journal_proj_tombstones',
    id: 'item_id',
    value: 'revision',
    counter: 'tombstones'
  },
  removedTurnIds: {
    table: 'journal_proj_removed_turns',
    id: 'turn_id',
    value: 'turn_id',
    counter: 'removed_turns'
  },
  appliedSettlementIds: {
    table: 'journal_proj_settlements',
    id: 'settlement_id',
    value: 'settlement_id',
    counter: 'settlements'
  },
  normalizedHandOffs: {
    table: 'journal_proj_normalized_handoffs',
    id: 'input_id',
    value: 'input_id',
    counter: 'normalized_handoffs'
  }
} as const
type Fact = keyof typeof FACTS

export function journalSqlPrimitiveTable(collection: string): JournalSqlPrimitiveTable | undefined {
  if (Object.hasOwn(FACTS, collection)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each named scalar family has its fixed typed table above.
    return FACTS[collection as Fact]
  }
  return undefined
}
