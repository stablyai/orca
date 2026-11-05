import type { GlobalSettings } from '../../../shared/global-settings-types'

// Partial so subset fences share the type.
type SettingsSnapshot = Readonly<Partial<GlobalSettings>>

// Revisions ride on each settings object, so any getSettings() reader can tell A→B→A from no change.
const revisionsBySettings = new WeakMap<SettingsSnapshot, ReadonlyMap<string, number>>()
let latestRevision = 0
const EMPTY_REVISIONS: ReadonlyMap<string, number> = new Map()

export function trackSettingsKeyRevisions(settings: SettingsSnapshot): void {
  if (!revisionsBySettings.has(settings)) {
    revisionsBySettings.set(settings, EMPTY_REVISIONS)
  }
}

export function recordSettingsReplacement(
  previous: SettingsSnapshot,
  next: SettingsSnapshot
): void {
  if (previous === next) {
    return
  }
  const base = revisionsBySettings.get(previous) ?? EMPTY_REVISIONS
  const before = new Map(Object.entries(previous))
  const after = new Map(Object.entries(next))
  let revisions: Map<string, number> | undefined
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key)
    const b = after.get(key)
    if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) {
      continue
    }
    revisions ??= new Map(base)
    revisions.set(key, ++latestRevision)
  }
  revisionsBySettings.set(next, revisions ?? base)
}

export function readSettingsKeyRevision(
  settings: SettingsSnapshot,
  key: string
): number | undefined {
  const revisions = revisionsBySettings.get(settings)
  return revisions === undefined ? undefined : (revisions.get(key) ?? 0)
}
