// Polytoken's hooks.json is a JSON array of `{ name, event, matcher?, handler: { bash } }`
// entries (global file merged before project hooks). Orca owns entries by name only, so
// user and third-party entries survive install/remove byte-for-byte and in order.

// Why: `notification` payloads are agent-internal (job/subagent completions), and the
// fire-and-forget `post_model_turn` can land after the blocking `stop` and flip a finished
// pane back to working, so neither is registered.
export const POLYTOKEN_HOOK_EVENTS = [
  'session_start',
  'pre_user_prompt',
  'pre_model_turn',
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'stop'
] as const
export type PolytokenHookEvent = (typeof POLYTOKEN_HOOK_EVENTS)[number]

export const ORCA_MANAGED_POLYTOKEN_HOOK_NAME_PREFIX = 'orca-managed-polytoken-'
// Why: an earlier, unreleased Orca build wrote `orca-managed-<event>` entries for every
// documented event; sweep those exact names too so repair replaces them instead of leaving
// stale handlers behind or stacking duplicates.
const DOCUMENTED_POLYTOKEN_HOOK_EVENTS = [
  ...POLYTOKEN_HOOK_EVENTS,
  'post_model_turn',
  'pre_compaction',
  'post_compaction',
  'post_clear',
  'notification',
  'facet_switch',
  'subagent_start',
  'subagent_stop'
] as const
const LEGACY_MANAGED_NAMES: ReadonlySet<string> = new Set(
  DOCUMENTED_POLYTOKEN_HOOK_EVENTS.map((event) => `orca-managed-${event}`)
)

export type PolytokenHookEntry = Record<string, unknown>

export type ParsedPolytokenHooksJson =
  | { ok: true; entries: PolytokenHookEntry[] }
  | { ok: false; error: string }

export function managedPolytokenHookName(event: PolytokenHookEvent): string {
  return `${ORCA_MANAGED_POLYTOKEN_HOOK_NAME_PREFIX}${event}`
}

export function isOrcaManagedPolytokenHookEntry(entry: PolytokenHookEntry): boolean {
  const name = entry.name
  return (
    typeof name === 'string' &&
    (name.startsWith(ORCA_MANAGED_POLYTOKEN_HOOK_NAME_PREFIX) || LEGACY_MANAGED_NAMES.has(name))
  )
}

// Why: fail closed on anything that is not an array of objects — a hand-edited file Orca
// cannot round-trip must be reported, never rewritten.
export function parsePolytokenHooksJson(text: string): ParsedPolytokenHooksJson {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (trimmed.length === 0) {
    return { ok: true, entries: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, error: `hooks.json is not valid JSON: ${(error as Error).message}` }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'hooks.json must be a JSON array of hook entries' }
  }
  if (
    !parsed.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
  ) {
    return { ok: false, error: 'hooks.json contains a hook entry that is not an object' }
  }
  return { ok: true, entries: parsed as PolytokenHookEntry[] }
}

export function buildManagedPolytokenHookEntries(handlerBash: string): PolytokenHookEntry[] {
  return POLYTOKEN_HOOK_EVENTS.map((event) => ({
    name: managedPolytokenHookName(event),
    event,
    handler: { bash: handlerBash }
  }))
}

export function applyManagedPolytokenHooks(
  entries: readonly PolytokenHookEntry[],
  handlerBash: string
): PolytokenHookEntry[] {
  return [
    ...entries.filter((entry) => !isOrcaManagedPolytokenHookEntry(entry)),
    ...buildManagedPolytokenHookEntries(handlerBash)
  ]
}

export function removeManagedPolytokenHooks(entries: readonly PolytokenHookEntry[]): {
  entries: PolytokenHookEntry[]
  changed: boolean
} {
  const kept = entries.filter((entry) => !isOrcaManagedPolytokenHookEntry(entry))
  return { entries: kept, changed: kept.length !== entries.length }
}

function handlerBash(entry: PolytokenHookEntry): string | undefined {
  const handler = entry.handler
  if (handler === null || typeof handler !== 'object') {
    return undefined
  }
  const bash = (handler as Record<string, unknown>).bash
  return typeof bash === 'string' ? bash : undefined
}

// Returns the managed events whose handler still points at an Orca-managed script (matched
// by filename, so a moved userData path is still swept).
export function readManagedPolytokenHookEvents(
  entries: readonly PolytokenHookEntry[],
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const present = new Set<string>()
  for (const entry of entries) {
    if (!isOrcaManagedPolytokenHookEntry(entry)) {
      continue
    }
    const event = entry.event
    if (typeof event === 'string' && isManagedCommand(handlerBash(entry))) {
      present.add(event)
    }
  }
  return present
}

export function serializePolytokenHooksJson(entries: readonly PolytokenHookEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}
