import type { GlobalSettings } from '../../shared/types'

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
}

// Why: background and foreground are intentionally omitted from v1 mapping.
// GlobalSettings has no raw terminal color fields — themes are name-based
// (terminalThemeDark / terminalThemeLight). Treating them as unsupported
// keeps the import safe and avoids silent data loss.
const SUPPORTED_KEY_MAP: Record<string, keyof GlobalSettings> = {
  'font-family': 'terminalFontFamily',
  'font-size': 'terminalFontSize',
  'cursor-style': 'terminalCursorStyle'
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
    } else if (mappedKey === 'terminalCursorStyle') {
      if (value !== 'bar' && value !== 'block' && value !== 'underline') {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = value
    } else {
      // Why: TypeScript's strict assignment checking for Partial<T>[K] requires
      // a cast because GlobalSettings has no index signature.
      ;(diff as Record<string, string | number>)[mappedKey] = value
    }
  }

  return { diff, unsupportedKeys }
}
