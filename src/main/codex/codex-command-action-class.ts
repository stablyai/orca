import { readRecord, readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

type CommandActionClass = {
  name: string
  /** Directory targets use directory; path becomes an open-file link on mobile. */
  keys: Readonly<Record<string, string>>
}

// Map avoids prototype-key matches such as __proto__.
const COMMAND_ACTION_CLASSES = new Map<string, CommandActionClass>([
  ['read', { name: 'read', keys: { path: 'path' } }],
  ['search', { name: 'search', keys: { query: 'query', path: 'directory' } }],
  ['listFiles', { name: 'list', keys: { path: 'directory' } }]
])

/** Mixed action classes retain the full shell command; matching classes keep only agreed fields. */
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
        // Missing targets must stay absent: fabricated paths become misleading file links.
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
