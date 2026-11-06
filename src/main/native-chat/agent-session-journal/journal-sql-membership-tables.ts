import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlPrimitiveFact } from './journal-sql-primitive-facts'

const MEMBERS = [
  {
    name: 'signed-out-members:',
    table: 'journal_proj_signed_out_inputs',
    group: 'fence',
    id: 'input_id'
  },
  {
    name: 'kept-card-members:',
    table: 'journal_proj_kept_card_inputs',
    group: 'message_id',
    id: 'input_id'
  },
  {
    name: 'carrier-coverers:',
    table: 'journal_proj_input_coverers',
    group: 'input_id',
    id: 'carrier_id'
  },
  { name: 'phase:', table: 'journal_proj_phase_members', group: 'phase', id: 'input_id' },
  {
    name: 'link-family:',
    table: 'journal_proj_link_family_members',
    group: 'family_id',
    id: 'input_id'
  }
] as const

export function journalSqlMemberIds(scope: JournalSqlScope, collection: string) {
  const family = MEMBERS.find((member) => collection.startsWith(member.name))
  if (!family) {
    return undefined
  }
  return new JournalSqlPrimitiveFact(scope, {
    table: family.table,
    id: family.id,
    ...(family.name === 'phase:' || family.name === 'link-family:'
      ? { value: 'payload_json', payload: true }
      : { value: family.id }),
    counter: 'members',
    group: {
      column: family.group,
      value: JSON.parse(collection.slice(family.name.length)),
      counterTable: `${family.table}_counters`
    }
  })
}
