import { COMPUTER_AWAKE_MODES } from '../../shared/computer-awake-mode'
import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../shared/crash-reporting'
import { recordCoalescedDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

// A settings pane debounces writes while a field is edited; one crumb per burst
// keeps the 30-slot ring describing the whole session, not the last slider drag.
const SETTINGS_CHANGE_COALESCE_MS = 5_000
// Bulk writes (settings import, migration) must not evict the rest of the ring,
// so a crumb carries a bounded number of value entries.
const MAX_REPORTED_KEYS = 12

/** Settings whose entire value space is a short closed vocabulary, so the value
 *  itself can be uploaded. Every other key — recognised or not — reports a shape:
 *  settings also hold API tokens, account ids, absolute paths, hostnames, repo
 *  names and custom agent commands. Adding a key here is a privacy decision, and
 *  `settings-change-breadcrumb.test.ts` rejects an entry that is not a closed enum. */
export const SAFE_ENUM_SETTING_VALUES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['theme', ['system', 'dark', 'light']],
  ['computerAwakeMode', COMPUTER_AWAKE_MODES]
])

/** A description safe to upload in a crash bundle: the real value only for
 *  booleans, finite numbers and allowlisted enums; anything else — an
 *  unrecognised key included — collapses to type and size. */
export function describeSettingValueForCrashReport(
  key: string,
  value: unknown
): CrashReportDetailValue {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 'number'
  }
  if (value === null || value === undefined) {
    return 'unset'
  }
  if (typeof value === 'string') {
    if (SAFE_ENUM_SETTING_VALUES.get(key)?.includes(value)) {
      return value
    }
    return value.length === 0 ? 'cleared' : `string(${value.length})`
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`
  }
  if (typeof value === 'object') {
    // Key count only: serializing the object would leak content and put a deep
    // walk on every settings write.
    return `object(${Object.keys(value).length})`
  }
  return 'set'
}

/** Durable breadcrumb for a settings write that actually changed something, so a
 *  crash report's "Recent activity" can corroborate or refute a user note. */
export function recordSettingsChangeCrashBreadcrumb(
  changedKeys: readonly string[],
  // Keyed by string, not by GlobalSettings: a key the type does not know about
  // is exactly the case the shape rule below has to cover.
  settingsAfterWrite: Readonly<Record<string, unknown>>
): void {
  if (changedKeys.length === 0) {
    return
  }
  const sortedKeys = [...changedKeys].sort()
  const data: CrashReportBreadcrumbData = { changedKeyCount: sortedKeys.length }
  for (const key of sortedKeys.slice(0, MAX_REPORTED_KEYS)) {
    data[key] = describeSettingValueForCrashReport(key, settingsAfterWrite[key])
  }
  if (sortedKeys.length > MAX_REPORTED_KEYS) {
    data.omittedKeyCount = sortedKeys.length - MAX_REPORTED_KEYS
  }
  recordCoalescedDurableCrashBreadcrumb({
    name: 'settings_changed',
    data,
    coalesceKey: sortedKeys.join(' '),
    minIntervalMs: SETTINGS_CHANGE_COALESCE_MS
  })
}
