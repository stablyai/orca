export const journalSqlSubmissionMemberTables = {
  'inputs.candidates': {
    table: 'journal_proj_input_candidates',
    id: 'input_id',
    counter: 'candidates'
  },
  'order.queued': { table: 'journal_proj_queued_inputs', id: 'input_id', counter: 'queued_inputs' },
  'order.entered': {
    table: 'journal_proj_entered_inputs',
    id: 'input_id',
    counter: 'entered_inputs'
  },
  'evidence.recoverable': {
    table: 'journal_proj_recoverable_inputs',
    id: 'input_id',
    counter: 'recoverable_inputs'
  },
  'evidence.statusPending': {
    table: 'journal_proj_pending_status_inputs',
    id: 'input_id',
    counter: 'pending_status_inputs'
  }
} as const

export function journalSqlSubmissionMemberTable(collection: string): string | undefined {
  if (Object.hasOwn(journalSqlSubmissionMemberTables, collection)) {
    return journalSqlSubmissionMemberTables[
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the named input membership families own these tables.
      collection as keyof typeof journalSqlSubmissionMemberTables
    ].table
  }
  return undefined
}
