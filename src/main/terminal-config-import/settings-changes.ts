import type { GlobalSettings } from '../../shared/global-settings-types'

// Compare nested values structurally with sorted keys while preserving meaningful array order.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(v).sort(([ka], [kb]) => ka.localeCompare(kb))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return stableStringify(a) === stableStringify(b)
  }
  return false
}

// An unset object setting already matches an import that clears it.
function emptyLike(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? {} : undefined
}

/** The part of an imported settings patch that would actually change the current settings. */
export function settingsChanges(
  current: GlobalSettings,
  patch: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => {
      const currentValue: unknown = key in current ? Reflect.get(current, key) : undefined
      return value !== undefined && !valuesEqual(currentValue ?? emptyLike(value), value)
    })
  )
}
