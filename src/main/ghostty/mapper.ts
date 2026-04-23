import type { GlobalSettings, TerminalColorOverrides } from '../../shared/types'

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
}

// Why: Ghostty allows colors with or without the leading hash.
const HEX_COLOR_RE = /^#?([0-9a-fA-F]{3}){1,2}$/

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

// Simple keys that map 1:1 to GlobalSettings fields.
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

  for (const [key, rawValue] of Object.entries(parsed)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue

    if (key === 'macos-option-as-alt') {
      if (!isMacOS) {
        unsupportedKeys.push(key)
        continue
      }
      const v = value as string
      if (v === 'true' || v === 'on') {
        diff.terminalMacOptionAsAlt = 'true'
      } else if (v === 'false' || v === 'off') {
        diff.terminalMacOptionAsAlt = 'false'
      } else if (v === 'left' || v === 'right') {
        diff.terminalMacOptionAsAlt = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'background-opacity') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalBackgroundOpacity = num
      continue
    }

    if (key === 'background') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.background = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'foreground') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.foreground = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'cursor-color') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.cursor = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'selection-background') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.selectionBackground = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'selection-foreground') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.selectionForeground = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'palette') {
      const entries = Array.isArray(rawValue) ? rawValue : [rawValue]
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
          colorOverrides[mapped] = color
        }
      }
      continue
    }

    if (key === 'background-blur-radius') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || Number.isNaN(num)) {
        unsupportedKeys.push(key)
        continue
      }
      diff.windowBackgroundBlur = num > 0
      continue
    }

    if (key === 'window-padding-color') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        diff.terminalPanePaddingColor = v
      } else if (v.toLowerCase() === 'extend' || v.toLowerCase() === 'background') {
        // Why: Ghostty's 'extend' and 'background' mean "inherit the terminal
        // background color for padding", which is already Orca's default when
        // terminalPanePaddingColor is undefined. No diff needed.
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'window-padding-balance') {
      const v = value as string
      if (v !== 'true' && v !== 'false') {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalPaddingBalance = v === 'true'
      continue
    }

    if (key === 'split-divider-color') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        diff.terminalDividerColorDark = v
        diff.terminalDividerColorLight = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'unfocused-split-opacity') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalInactivePaneOpacity = num
      continue
    }

    if (key === 'scrollback-limit') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || Number.isNaN(num) || !Number.isInteger(num) || num < 0) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalScrollbackLimit = num
      continue
    }

    if (key === 'window-padding-x') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || Number.isNaN(num) || !Number.isInteger(num)) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalPaddingX = num
      continue
    }

    if (key === 'window-padding-y') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || Number.isNaN(num) || !Number.isInteger(num)) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalPaddingY = num
      continue
    }

    if (key === 'cursor-text') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.cursorAccent = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'bold-color') {
      const v = value as string
      if (HEX_COLOR_RE.test(v)) {
        colorOverrides.bold = v
      } else {
        unsupportedKeys.push(key)
      }
      continue
    }

    if (key === 'mouse-hide-while-typing') {
      const v = value as string
      if (v !== 'true' && v !== 'false') {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalMouseHideWhileTyping = v === 'true'
      continue
    }

    if (key === 'selection-word-chars') {
      diff.terminalWordSeparator = value as string
      continue
    }

    if (key === 'cursor-opacity') {
      const v = value as string
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        unsupportedKeys.push(key)
        continue
      }
      diff.terminalCursorOpacity = num
      continue
    }

    const mappedKey = SUPPORTED_KEY_MAP[key]
    if (!mappedKey) {
      unsupportedKeys.push(key)
      continue
    }

    const v = value as string

    if (mappedKey === 'terminalFontSize') {
      const num = Number(v)
      if (!Number.isFinite(num) || num <= 0) {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = num
    } else if (mappedKey === 'terminalFontWeight') {
      const num = Number(v)
      if (!Number.isFinite(num) || num < 100 || num > 900) {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = num
    } else if (mappedKey === 'terminalCursorStyle') {
      if (v !== 'bar' && v !== 'block' && v !== 'underline') {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = v
    } else if (mappedKey === 'terminalCursorBlink' || mappedKey === 'terminalFocusFollowsMouse') {
      // Why: Ghostty uses 'true'/'false' strings for booleans; anything else
      // is treated as unsupported rather than silently coerced.
      if (v !== 'true' && v !== 'false') {
        unsupportedKeys.push(key)
        continue
      }
      diff[mappedKey] = v === 'true'
    } else {
      // Why: TypeScript's strict assignment checking for Partial<T>[K] requires
      // a cast because GlobalSettings has no index signature.
      ;(diff as Record<string, string | number>)[mappedKey] = v
    }
  }

  if (Object.keys(colorOverrides).length > 0) {
    diff.terminalColorOverrides = colorOverrides
  }

  return { diff, unsupportedKeys }
}
