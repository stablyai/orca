import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TerminalColorOverrides } from '../../shared/terminal-color-overrides'
import {
  normalizeTerminalHexColor,
  TERMINAL_ANSI_COLOR_KEYS
} from '../../shared/terminal-custom-themes'
import type { KittyConfig } from './parser'

// Maps, not object literals, so option names like `constructor` cannot hit prototype keys.
const COLOR_KEYS = new Map<string, keyof TerminalColorOverrides>([
  ['foreground', 'foreground'],
  ['background', 'background'],
  ['cursor', 'cursor'],
  ['cursor_text_color', 'cursorAccent'],
  ['selection_foreground', 'selectionForeground'],
  ['selection_background', 'selectionBackground'],
  ...TERMINAL_ANSI_COLOR_KEYS.map((key, index): [string, keyof TerminalColorOverrides] => [
    `color${index}`,
    key
  ])
])

const CURSOR_SHAPES = new Map<string, GlobalSettings['terminalCursorStyle']>([
  ['block', 'block'],
  ['beam', 'bar'],
  ['underline', 'underline']
])

// Kitty lowercases these and accepts its usual boolean spellings for "both".
const OPTION_AS_ALT = new Map<string, GlobalSettings['terminalMacOptionAsAlt']>([
  ['y', 'true'],
  ['yes', 'true'],
  ['true', 'true'],
  ['both', 'true'],
  ['n', 'false'],
  ['no', 'false'],
  ['false', 'false'],
  ['none', 'false'],
  ['left', 'left'],
  ['right', 'right']
])

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/

function parseNumber(value: string, min: number, max: number): number | null {
  const num = DECIMAL_RE.test(value.trim()) ? Number(value) : Number.NaN
  return num >= min && num <= max ? num : null
}

// `font_family` is a bare name or Kitty 0.36's `family="Name" style=...` spec; `monospace` means "system default".
function kittyFontFamily(value: string): string | null {
  const spec = /(?:^|\s)family=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(value)
  // Other selectors (postscript_name=, full_name=) name a face Orca cannot look up.
  if (!spec && /^\w+=/.test(value)) {
    return null
  }
  const family = (spec ? (spec[1] ?? spec[2] ?? spec[3]) : value).trim()
  return family && family !== 'monospace' && family !== 'auto' ? family : null
}

// One value pads every side; two are vertical then horizontal; three are top, horizontal, bottom; four go clockwise from top.
function kittyPadding(value: string): { x: number; y: number } | null {
  const sides = value.split(/\s+/).map((side) => parseNumber(side, 0, 512))
  if (sides.length === 0 || sides.length > 4 || sides.some((side) => side === null)) {
    return null
  }
  const [top = 0, right = top, bottom = top, left = right] = sides.map((side) => side ?? 0)
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

function mapOption(
  key: string,
  value: string,
  isMacOS: boolean,
  diff: Partial<GlobalSettings>,
  colors: TerminalColorOverrides
): boolean {
  const colorKey = COLOR_KEYS.get(key)
  if (colorKey) {
    const color = normalizeTerminalHexColor(value)
    if (color) {
      colors[colorKey] = color
    }
    return color !== null
  }
  switch (key) {
    case 'font_family': {
      const family = kittyFontFamily(value)
      if (family) {
        diff.terminalFontFamily = family
      }
      return family !== null
    }
    case 'font_size': {
      const size = parseNumber(value, 1, 200)
      if (size !== null) {
        diff.terminalFontSize = size
      }
      return size !== null
    }
    case 'background_opacity': {
      const opacity = parseNumber(value, 0, 1)
      if (opacity !== null) {
        diff.terminalBackgroundOpacity = opacity
      }
      return opacity !== null
    }
    case 'background_blur': {
      const radius = parseNumber(value, 0, 512)
      if (radius !== null) {
        diff.windowMaterial = radius > 0 ? 'blur' : 'translucent'
      }
      return radius !== null
    }
    case 'cursor_shape': {
      const style = CURSOR_SHAPES.get(value.toLowerCase())
      if (style) {
        diff.terminalCursorStyle = style
      }
      return style !== undefined
    }
    case 'cursor_blink_interval': {
      // The first token is seconds (0 disables, negative uses the OS rate); easing curves may follow.
      const interval = parseNumber(value.split(/\s+/)[0] ?? '', -1, 3600)
      if (interval !== null) {
        diff.terminalCursorBlink = interval !== 0
      }
      return interval !== null
    }
    case 'window_padding_width': {
      const padding = kittyPadding(value)
      if (padding) {
        diff.terminalPaddingX = padding.x
        diff.terminalPaddingY = padding.y
      }
      return padding !== null
    }
    case 'macos_option_as_alt': {
      const optionAsAlt = isMacOS ? OPTION_AS_ALT.get(value.toLowerCase()) : undefined
      if (optionAsAlt) {
        diff.terminalMacOptionAsAlt = optionAsAlt
      }
      return optionAsAlt !== undefined
    }
    default:
      return false
  }
}

export function mapKittyToOrca(
  config: KittyConfig,
  isMacOS: boolean
): { diff: Partial<GlobalSettings>; unsupportedKeys: string[] } {
  const diff: Partial<GlobalSettings> = {}
  const colors: TerminalColorOverrides = {}
  const unsupportedKeys = [...config.unsupportedKeys]
  for (const [key, value] of config.options) {
    if (!mapOption(key, value, isMacOS, diff, colors)) {
      unsupportedKeys.push(key)
    }
  }
  if (Object.keys(colors).length > 0) {
    diff.terminalColorOverrides = colors
  }
  return { diff, unsupportedKeys }
}
