import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export const DSH_CONSOLE_PLUGIN_ID = 'orca-dsh-console-status'
const entry = { insert: [{ id: DSH_CONSOLE_PLUGIN_ID, name: './orca-status/index.mjs' }] }

/** Edit the YAML syntax tree so user comments and DSH !!js expressions survive. */
export function updateDshConsolePatch(source: string | null, enabled: boolean): string {
  const doc = parseDocument(source ?? '[]\n', { strict: true })
  if (doc.errors.length) {
    throw new Error(`Invalid DSH profile patch: ${doc.errors[0].message}`)
  }
  if (!isSeq(doc.contents)) {
    throw new Error('DSH profile patch must be a YAML array')
  }
  const owned: number[] = []
  for (const [index, item] of doc.contents.items.entries()) {
    if (!isMap(item)) {
      continue
    }
    const targetId = item.get('id', true)
    if (isScalar(targetId) && (targetId.value as unknown) === DSH_CONSOLE_PLUGIN_ID) {
      throw new Error('DSH profile contains a user override of the Orca plugin entry')
    }
    const insert = item.get('insert', true)
    if (!isSeq(insert)) {
      continue
    }
    for (const plugin of insert.items) {
      if (!isMap(plugin) || plugin.get('id') !== DSH_CONSOLE_PLUGIN_ID) {
        continue
      }
      if (
        insert.items.length !== 1 ||
        item.items.length !== 1 ||
        plugin.items.length !== 2 ||
        plugin.get('name') !== './orca-status/index.mjs'
      ) {
        throw new Error('DSH profile contains a conflicting Orca plugin entry')
      }
      owned.push(index)
    }
  }
  if (enabled && owned.length === 1) {
    return source!
  }
  if (!enabled && owned.length === 0) {
    return source ?? '[]\n'
  }
  for (const index of owned.toReversed()) {
    doc.contents.items.splice(index, 1)
  }
  if (enabled) {
    doc.add(entry)
  }
  return String(doc)
}

export function hasDshConsolePatch(source: string | null): boolean {
  return source !== null && updateDshConsolePatch(source, false) !== source
}
