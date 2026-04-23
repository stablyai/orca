import type { GlobalSettings } from '../../shared/types'

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
}

// Why: background and foreground are intentionally omitted — GlobalSettings
// has no raw terminal color fields (themes are name-based). Color keys are
// treated as unsupported to keep import safe and avoid silent data loss.
const SUPPORTED_KEY_MAP: Record<string, keyof GlobalSettings> = {
  'font-family': 'terminalFontFamily',
  'font-size': 'terminalFontSize',
  'font-weight': 'terminalFontWeight',
  'cursor-style': 'terminalCursorStyle',
  // Why: Ghostty uses 'cursor-style-blink' as a boolean string; maps directly
  // to Orca's terminalCursorBlink toggle.
  'cursor-style-blink': 'terminalCursorBlink',
  // Why: Ghostty's focus-follows-mouse is semantically identical to Orca's
  // terminalFocusFollowsMouse — both control pointer-hover focus transfer.
  'focus-follows-mouse': 'terminalFocusFollowsMouse'
}

export function mapGhosttyToOrca(parsed: Record<string, string>): {
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
} {
  const diff: Partial<GlobalSettings> = {}
  const unsupportedKeys: string[] = []

  for (const [key, value] of Object.entries(parsed)) {
    const mappedKey = SUPPORTED_KEY_MAP[key]
    if (!mappedKey) {
      unsupportedKeys.push(key)
      continue
    }

    if (mappedKey === 'terminalFontSize') {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = num
    } else if (mappedKey === 'terminalFontWeight') {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 100 || num > 900) {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = num
    } else if (mappedKey === 'terminalCursorStyle') {
      if (value !== 'bar' && value !== 'block' && value !== 'underline') {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = value
    } else if (mappedKey === 'terminalCursorBlink' || mappedKey === 'terminalFocusFollowsMouse') {
      // Why: Ghostty uses 'true'/'false' strings for booleans; anything else
      // is treated as unsupported rather than silently coerced.
      if (value !== 'true' && value !== 'false') {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = value === 'true'
    } else {
      // Why: TypeScript's strict assignment checking for Partial<T>[K] requires
      // a cast because GlobalSettings has no index signature.
      ;(diff as Record<string, string | number>)[mappedKey] = value
    }
  }

  return { diff, unsupportedKeys }
}
