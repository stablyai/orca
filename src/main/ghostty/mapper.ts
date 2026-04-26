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
      return { colorOverrides: { background: v } }
    },

    foreground: (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { foreground: v } }
    },

    'cursor-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { cursor: v } }
    },

    'selection-background': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { selectionBackground: v } }
    },

    'selection-foreground': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { selectionForeground: v } }
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
          overrides[mapped] = color
        }
      }
      return { colorOverrides: overrides }
    },

    'background-blur-radius': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num)) {
        return null
      }
      return { key: 'windowBackgroundBlur', value: num > 0 }
    },

    'window-padding-color': (v) => {
      if (HEX_COLOR_RE.test(v)) {
        return { key: 'terminalPanePaddingColor', value: v }
      }
      if (v.toLowerCase() === 'extend' || v.toLowerCase() === 'background') {
        // Why: Ghostty's 'extend' and 'background' mean "inherit the terminal
        // background color for padding", which is already Orca's default when
        // terminalPanePaddingColor is undefined. No diff needed.
        return []
      }
      return null
    },

    'window-padding-balance': (v) => {
      if (v !== 'true' && v !== 'false') {
        return null
      }
      return { key: 'terminalPaddingBalance', value: v === 'true' }
    },

    'split-divider-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return [
        { key: 'terminalDividerColorDark', value: v },
        { key: 'terminalDividerColorLight', value: v }
      ]
    },

    'unfocused-split-opacity': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return null
      }
      return { key: 'terminalInactivePaneOpacity', value: num }
    },

    'scrollback-limit': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
        return null
      }
      return { key: 'terminalScrollbackLimit', value: num }
    },

    'window-padding-x': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        return null
      }
      return { key: 'terminalPaddingX', value: num }
    },

    'window-padding-y': (v) => {
      const num = Number(v)
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        return null
      }
      return { key: 'terminalPaddingY', value: num }
    },

    'cursor-text': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { cursorAccent: v } }
    },

    'bold-color': (v) => {
      if (!HEX_COLOR_RE.test(v)) {
        return null
      }
      return { colorOverrides: { bold: v } }
    },

    'mouse-hide-while-typing': (v) => {
      if (v !== 'true' && v !== 'false') {
        return null
      }
      return { key: 'terminalMouseHideWhileTyping', value: v === 'true' }
    },

    'selection-word-chars': (v) => {
      return { key: 'terminalWordSeparator', value: v }
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
