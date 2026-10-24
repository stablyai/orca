/** Absent permits legacy inference; preserve unknown declarations without authorizing delivery recovery. */
export type JournalItemEcho = { echoOf?: unknown }

export function journalItemEchoFields(item: JournalItemEcho): JournalItemEcho {
  return Object.hasOwn(item, 'echoOf') ? { echoOf: item.echoOf ?? null } : {}
}

export function journalItemDeclaresEcho(
  declarations: ReadonlyMap<string, unknown>,
  itemId: string,
  incoming: JournalItemEcho = {}
): boolean {
  return declarations.has(itemId) || Object.hasOwn(incoming, 'echoOf')
}

export function journalItemEchoRestatement(
  declarations: ReadonlyMap<string, unknown>,
  itemId: string
): JournalItemEcho {
  return declarations.has(itemId) ? { echoOf: declarations.get(itemId) } : {}
}
