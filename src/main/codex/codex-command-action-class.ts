import { readRecord, readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

/**
 * Codex's own classification of a shell call: the tool name to show, and the
 * fields worth lifting into `input` for the shared label helper (a file target,
 * a search term, a scanned root). A `Map`, not an object — an object index
 * answers `__proto__` with a truthy non-string. Every other action type stays an
 * unclassified `shell` row.
 *
 * Nothing is invented for a field Codex sends as null: a stand-in path is a
 * claim about a target, and the label helper turns any path into a file link.
 */
type CommandActionClass = {
  name: string
  /** Action field to the `input` key it lifts to. A scan root and a listed
   *  directory lift to `directory`, never `path`: the label helper reads `path`
   *  as a file target, which mobile turns into a tappable open-file link. */
  keys: Readonly<Record<string, string>>
}

const COMMAND_ACTION_CLASSES = new Map<string, CommandActionClass>([
  ['read', { name: 'read', keys: { path: 'path' } }],
  ['search', { name: 'search', keys: { query: 'query', path: 'directory' } }],
  ['listFiles', { name: 'list', keys: { path: 'directory' } }]
])

/** The one class every classified `commandActions` entry agrees on, with the
 *  fields they all agree on; null leaves the row exactly as a Codex that sends no
 *  classification renders it. `cat a.txt && ls src` classifies as two different
 *  things, and naming that row after either would drop the other, so it stays a
 *  `shell` row that shows the whole command. */
export function commandActionFacts(
  item: CodexThreadItem
): { name: string; fields: Record<string, string> } | null {
  const actions = item.commandActions
  if (!Array.isArray(actions)) {
    return null
  }
  let matched: { class: CommandActionClass; fields: Record<string, string> } | null = null
  for (const action of actions) {
    const record = readRecord(action)
    const type = readString(record, 'type')
    const classified = type === null ? undefined : COMMAND_ACTION_CLASSES.get(type)
    if (classified === undefined) {
      continue
    }
    if (matched === null) {
      const fields: Record<string, string> = {}
      for (const [source, lifted] of Object.entries(classified.keys)) {
        const value = readString(record, source)
        if (value !== null) {
          fields[lifted] = value
        }
      }
      matched = { class: classified, fields }
      continue
    }
    if (matched.class.name !== classified.name) {
      return null
    }
    // The same class twice keeps the class, but only a target both entries name.
    for (const [source, lifted] of Object.entries(matched.class.keys)) {
      const kept = matched.fields[lifted]
      if (kept !== undefined && readString(record, source) !== kept) {
        delete matched.fields[lifted]
      }
    }
  }
  return matched === null ? null : { name: matched.class.name, fields: matched.fields }
}
