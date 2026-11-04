export type JournalTableScope = 'main' | 'surface_chat'

/** Attached writes must never resolve a same-named table in the profile or temp schema. */
export function journalTable(scope: JournalTableScope, table: string): string {
  return scope === 'surface_chat' ? `surface_chat.${table}` : table
}
