import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TerminalColorOverrides } from '../../shared/terminal-color-overrides'
import {
  normalizeTerminalHexColor,
  TERMINAL_ANSI_COLOR_KEYS
} from '../../shared/terminal-custom-themes'
import type { KittyConfig } from './parser'

const COLOR_KEYS: Record<string, keyof TerminalColorOverrides> = {
  foreground: 'foreground',
  background: 'background',
  cursor: 'cursor',
  cursor_text_color: 'cursorAccent',
  selection_foreground: 'selectionForeground',
  selection_background: 'selectionBackground'
}

const CURSOR_SHAPES: Record<string, GlobalSettings['terminalCursorStyle']> = {
  block: 'block',
  beam: 'bar',
  underline: 'underline'
}

const OPTION_AS_ALT: Record<string, GlobalSettings['terminalMacOptionAsAlt']> = {
  yes: 'true',
  both: 'true',
  no: 'false',
  none: 'false',
  left: 'left',
  right: 'right'
}

function parseNumber(value: string): number | null {
  const num = Number(value)
  return value.trim() !== '' && Number.isFinite(num) ? num : null
}

// `font_family` is a bare name or Kitty 0.36's `family="Name" style=...` spec; `monospace` means "system default".
function kittyFontFamily(value: string): string | null {
  const spec = /(?:^|\s)family=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(value)
  const family = (spec ? (spec[1] ?? spec[2] ?? spec[3]) : value).trim()
  return family && family !== 'monospace' && family !== 'auto' ? family : null
}

// One value pads every side; two are vertical then horizontal; three are top, horizontal, bottom; four go clockwise from top.
function kittyPadding(value: string): { x: number; y: number } | null {
  const sides = value.split(/\s+/).map(parseNumber)
  if (sides.length === 0 || sides.length > 4 || sides.some((side) => side === null || side < 0)) {
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
  const colorKey =
    COLOR_KEYS[key] ?? TERMINAL_ANSI_COLOR_KEYS[Number(/^color(\d+)$/.exec(key)?.[1])]
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
      const size = parseNumber(value)
      if (size !== null && size > 0) {
        diff.terminalFontSize = size
      }
      return size !== null && size > 0
    }
    case 'background_opacity': {
      const opacity = parseNumber(value)
      if (opacity !== null && opacity >= 0 && opacity <= 1) {
        diff.terminalBackgroundOpacity = opacity
        return true
      }
      return false
    }
    case 'background_blur': {
      const radius = parseNumber(value)
      if (radius !== null && radius >= 0) {
        diff.windowMaterial = radius > 0 ? 'blur' : 'translucent'
      }
      return radius !== null && radius >= 0
    }
    case 'cursor_shape': {
      const style = CURSOR_SHAPES[value]
      if (style) {
        diff.terminalCursorStyle = style
      }
      return style !== undefined
    }
    case 'cursor_blink_interval': {
      // The first token is seconds (0 disables, negative uses the OS rate); easing curves may follow.
      const interval = parseNumber(value.split(/\s+/)[0] ?? '')
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
      const optionAsAlt = isMacOS ? OPTION_AS_ALT[value] : undefined
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
