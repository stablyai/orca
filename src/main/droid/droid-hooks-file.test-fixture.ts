import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'

export type DroidHookEntry = { matcher?: string; hooks: { type?: string; command: string }[] }

export function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (!isPlainObject(parsed)) {
    throw new Error('expected a JSON object')
  }
  return parsed
}

function isHookEntry(value: unknown): value is DroidHookEntry {
  return (
    isPlainObject(value) &&
    (value.matcher === undefined || typeof value.matcher === 'string') &&
    Array.isArray(value.hooks) &&
    value.hooks.every((hook) => isPlainObject(hook) && typeof hook.command === 'string')
  )
}

/** The entries under one event key, checked at runtime so a malformed file fails the test loudly. */
export function eventEntries(file: Record<string, unknown>, eventName: string): DroidHookEntry[] {
  const value = file[eventName]
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || !value.every(isHookEntry)) {
    throw new Error(`${eventName} is not a list of hook entries`)
  }
  return value
}
