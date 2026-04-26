import type {
  GlobalSettings,
  TerminalColorOverrides,
  GhosttyImportPreview
} from '../../shared/types'
import { HEX_COLOR_RE } from '../../shared/color-validation'

const PALETTE_INDEX_MAP: Record<number, keyof TerminalColorOverrides> = {
  0: 'black',
  1: 'red',
  2: 'green',
  3: 'yellow',
  4: 'blue',
  5: 'magenta',
  6: 'cyan',
  7: 'white',
  8: 'brightBlack',
  9: 'brightRed',
  10: 'brightGreen',
  11: 'brightYellow',
  12: 'brightBlue',
  13: 'brightMagenta',
  14: 'brightCyan',
  15: 'brightWhite'
}

type FieldAssignment = { key: keyof GlobalSettings; value: unknown }

type FieldResult =
  | FieldAssignment
  | FieldAssignment[]
  | { colorOverrides: Partial<TerminalColorOverrides> }
  | null

const normalizeHex = (v: string): string => (v.startsWith('#') ? v : `#${v}`)

// Why: `Number("1e10")` succeeds and passes `Number.isInteger`, so a Ghostty
// config with `window-padding-x = 1e9` would sail through the mapper and land
// an absurd value in the store. Restrict to plain decimal integers.
const STRICT_INT_RE = /^-?\d+$/
const parseStrictInt = (v: string): number | null => {
  if (!STRICT_INT_RE.test(v)) {
    return null
  }
  const num = Number(v)
  return Number.isFinite(num) ? num : null
}

type FieldParser = (value: string, rawValue: string | string[]) => FieldResult

export function mapGhosttyToOrca(
  parsed: Record<string, string | string[]>,
  isMacOS = process.platform === 'darwin'
): {
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
} {
  const diff: Partial<GlobalSettings> = {}
  const unsupportedKeys: string[] = []
  const colorOverrides: TerminalColorOverrides = {}

  const FIELD_PARSERS: Record<string, FieldParser> = {
    'macos-option-as-alt': (v) => {
      if (!isMacOS) {
        return null
      }
      if (v === 'true' || v === 'on') {
        return { key: 'terminalMacOptionAsAlt', value: 'true' }
      }
      if (v === 'false' || v === 'off') {
        return { key: 'terminalMacOptionAsAlt', value: 'false' }
      }
      if (v === 'left' || v === 'right') {
        return { key: 'terminalMacOptionAsAlt', value: v }
      }
      return null
    },

    'background-opacity': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return null
      }
      return { key: 'terminalBackgroundOpacity', value: num }
    },

    background: (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { background: normalizeHex(v) } }
    },

    foreground: (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { foreground: normalizeHex(v) } }
    },

    'cursor-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { cursor: normalizeHex(v) } }
    },

    'selection-background': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { selectionBackground: normalizeHex(v) } }
    },

    'selection-foreground': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { selectionForeground: normalizeHex(v) } }
    },

    palette: (_v, rawValue) => {
      const entries = Array.isArray(rawValue) ? rawValue : [rawValue]
      const overrides: Partial<TerminalColorOverrides> = {}
      for (const entry of entries) {
        const eqIdx = entry.indexOf('=')
        if (eqIdx === -1) {
          continue
        }
        const idxStr = entry.slice(0, eqIdx).trim()
        const color = entry.slice(eqIdx + 1).trim()
        const index = parseInt(idxStr, 10)
        if (Number.isNaN(index) || !HEX_COLOR_RE.test(color)) {
          continue
        }
        const mapped = PALETTE_INDEX_MAP[index]
        if (mapped) {
          overrides[mapped] = normalizeHex(color)
        }
      }
      if (Object.keys(overrides).length === 0 && entries.length > 0) {
        return null
      }
      return { colorOverrides: overrides }
    },

    'background-blur-radius': (v) => {
      const num = parseStrictInt(v)
      if (num === null || num < 0) {
        return null
      }
      return { key: 'windowBackgroundBlur', value: num > 0 }
    },

    'split-divider-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return [
        { key: 'terminalDividerColorDark', value: normalizeHex(v) },
        { key: 'terminalDividerColorLight', value: normalizeHex(v) }
      ]
    },

    'unfocused-split-opacity': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return null
      }
      return { key: 'terminalInactivePaneOpacity', value: num }
    },

    'window-padding-x': (v) => {
      const num = parseStrictInt(v)
      if (num === null || num < 0 || num > 512) {
        return null
      }
      return { key: 'terminalPaddingX', value: num }
    },

    'window-padding-y': (v) => {
      const num = parseStrictInt(v)
      if (num === null || num < 0 || num > 512) {
        return null
      }
      return { key: 'terminalPaddingY', value: num }
    },

    'cursor-text': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { cursorAccent: normalizeHex(v) } }
    },

    'bold-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { bold: normalizeHex(v) } }
    },

    'mouse-hide-while-typing': (v) => {
      if (v !== 'true' && v !== 'false') {
        return null
      }
      return { key: 'terminalMouseHideWhileTyping', value: v === 'true' }
    },

    'cursor-opacity': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return null
      }
      return { key: 'terminalCursorOpacity', value: num }
    },

    'font-family': (v) => {
      if (typeof v !== 'string' || v.trim().length === 0) {
        return null
      }
      return { key: 'terminalFontFamily', value: v }
    },

    'font-size': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num <= 0) {
        return null
      }
      return { key: 'terminalFontSize', value: num }
    },

    'font-weight': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 100 || num > 900) {
        return null
      }
      return { key: 'terminalFontWeight', value: num }
    },

    'cursor-style': (v) => {
      if (v !== 'bar' && v !== 'block' && v !== 'underline') {
        return null
      }
      return { key: 'terminalCursorStyle', value: v }
    },

    'cursor-style-blink': (v) => {
      // Why: Ghostty uses 'true'/'false' strings for booleans; anything else
      // is treated as unsupported rather than silently coerced.
      if (v !== 'true' && v !== 'false') {
        return null
      }
      return { key: 'terminalCursorBlink', value: v === 'true' }
    },

    'focus-follows-mouse': (v) => {
      // Why: Ghostty's focus-follows-mouse is semantically identical to Orca's
      // terminalFocusFollowsMouse — both control pointer-hover focus transfer.
      if (v !== 'true' && v !== 'false') {
        return null
      }
      return { key: 'terminalFocusFollowsMouse', value: v === 'true' }
    }
  }

  for (const [key, rawValue] of Object.entries(parsed)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue

    // Why: Ghostty's selection-word-chars defines characters that ARE part of a
    // word, while xterm.js wordSeparator defines characters that BREAK words.
    // Passing the same string inverts the semantics, and correctly inverting a
    // character set is non-trivial. Treat as unsupported to avoid silent misbehavior.
    if (key === 'selection-word-chars') {
      unsupportedKeys.push(key)
      continue
    }

    if (!value.trim()) {
      unsupportedKeys.push(key)
      continue
    }

    const parser = FIELD_PARSERS[key]
    if (!parser) {
      unsupportedKeys.push(key)
      continue
    }

    const result = parser(value, rawValue)
    if (result === null) {
      unsupportedKeys.push(key)
      continue
    }

    // Why: Orca's windowBackgroundBlur is a boolean; the numeric radius is lost.
    // Only note the drop when blur is actually being turned on — a `0` cleanly
    // maps to `false` and there is no radius to lose.
    if (
      key === 'background-blur-radius' &&
      !Array.isArray(result) &&
      'key' in result &&
      result.value === true
    ) {
      unsupportedKeys.push('background-blur-radius (radius value not preserved)')
    }

    if (Array.isArray(result)) {
      for (const entry of result) {
        // Why: TypeScript's strict assignment checking for Partial<T>[K] requires
        // a cast because GlobalSettings has no index signature.
        diff[entry.key] = entry.value as never
      }
    } else if ('colorOverrides' in result) {
      Object.assign(colorOverrides, result.colorOverrides)
    } else {
      diff[result.key] = result.value as never
    }
  }

  if (Object.keys(colorOverrides).length > 0) {
    diff.terminalColorOverrides = colorOverrides
  }

  return { diff, unsupportedKeys }
}

export type { GhosttyImportPreview }
