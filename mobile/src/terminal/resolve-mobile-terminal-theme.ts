import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import { DEFAULT_TERMINAL_THEMES } from '../../../src/shared/terminal-themes/defaults'
import type { MobileColorScheme } from '../theme/mobile-theme'
import { DEFAULT_TERMINAL_THEME } from './terminal-webview-html/theme'

const BUILTIN_LIGHT_SOURCE = DEFAULT_TERMINAL_THEMES['Builtin Tango Light']

export const MOBILE_LIGHT_TERMINAL_THEME: RuntimeMobileTerminalTheme['theme'] = {
  background: BUILTIN_LIGHT_SOURCE?.background ?? '#ffffff',
  foreground: BUILTIN_LIGHT_SOURCE?.foreground ?? '#2e3434',
  cursor: BUILTIN_LIGHT_SOURCE?.cursor ?? '#2e3434',
  cursorAccent: BUILTIN_LIGHT_SOURCE?.cursorAccent ?? '#ffffff',
  selectionBackground: BUILTIN_LIGHT_SOURCE?.selectionBackground ?? '#accef7',
  selectionForeground: BUILTIN_LIGHT_SOURCE?.selectionForeground ?? '#2e3434',
  black: BUILTIN_LIGHT_SOURCE?.black ?? '#2e3436',
  red: BUILTIN_LIGHT_SOURCE?.red ?? '#cc0000',
  green: BUILTIN_LIGHT_SOURCE?.green ?? '#4e9a06',
  yellow: BUILTIN_LIGHT_SOURCE?.yellow ?? '#8e7700',
  blue: BUILTIN_LIGHT_SOURCE?.blue ?? '#3465a4',
  magenta: BUILTIN_LIGHT_SOURCE?.magenta ?? '#75507b',
  cyan: BUILTIN_LIGHT_SOURCE?.cyan ?? '#05727e',
  white: BUILTIN_LIGHT_SOURCE?.white ?? '#6a6a6a',
  brightBlack: BUILTIN_LIGHT_SOURCE?.brightBlack ?? '#555753',
  brightRed: BUILTIN_LIGHT_SOURCE?.brightRed ?? '#ef2929',
  brightGreen: BUILTIN_LIGHT_SOURCE?.brightGreen ?? '#1b7a1b',
  brightYellow: BUILTIN_LIGHT_SOURCE?.brightYellow ?? '#6d5a00',
  brightBlue: BUILTIN_LIGHT_SOURCE?.brightBlue ?? '#204a87',
  brightMagenta: BUILTIN_LIGHT_SOURCE?.brightMagenta ?? '#ad7fa8',
  brightCyan: BUILTIN_LIGHT_SOURCE?.brightCyan ?? '#034b50',
  brightWhite: BUILTIN_LIGHT_SOURCE?.brightWhite ?? '#3d3d3d'
}

export const MOBILE_DARK_TERMINAL_THEME: RuntimeMobileTerminalTheme['theme'] =
  DEFAULT_TERMINAL_THEME

export function getMobileViewerColorQueryReplies(colorScheme: MobileColorScheme): {
  foreground: string
  background: string
} {
  const palette = colorScheme === 'light' ? MOBILE_LIGHT_TERMINAL_THEME : MOBILE_DARK_TERMINAL_THEME
  return {
    foreground: palette.foreground ?? (colorScheme === 'light' ? '#2e3434' : '#c0caf5'),
    background: palette.background ?? (colorScheme === 'light' ? '#ffffff' : '#1a1b26')
  }
}

function srgbChannelLuminance(channel255: number): number {
  const normalized = Math.max(0, Math.min(255, channel255)) / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export function parseCssColorRgb(value: string | undefined): [number, number, number] | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed)
  if (hexMatch) {
    const raw = hexMatch[1]!
    const full = raw.length === 3 ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}` : raw
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16)
    ]
  }
  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(trimmed)
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])]
  }
  return null
}

export function isLightTerminalBackground(background: string | undefined): boolean | null {
  const rgb = parseCssColorRgb(background)
  if (!rgb) {
    return null
  }
  const luminance =
    0.2126 * srgbChannelLuminance(rgb[0]) +
    0.7152 * srgbChannelLuminance(rgb[1]) +
    0.0722 * srgbChannelLuminance(rgb[2])
  return luminance >= 0.5
}

/**
 * Enforces the active mobile color scheme (`light` | `dark`) on terminal panes.
 *
 * When the desktop host publishes a custom palette whose mode and background
 * brightness already match the mobile scheme, keep that custom palette intact.
 * When mobile enforces Light over a Dark desktop session (or Dark over a Light
 * desktop session, or when desktop keeps `terminalUseSeparateLightTheme: false`),
 * substitute the matching built-in mobile Light or Dark xterm palette while
 * preserving the host's configured minimumContrastRatio.
 */
export function resolveEffectiveMobileTerminalTheme(
  hostTheme: RuntimeMobileTerminalTheme | undefined,
  colorScheme: MobileColorScheme
): RuntimeMobileTerminalTheme {
  const minimumContrastRatio =
    typeof hostTheme?.minimumContrastRatio === 'number' ? hostTheme.minimumContrastRatio : undefined

  if (hostTheme && hostTheme.mode === colorScheme && hostTheme.theme) {
    const lightBg = isLightTerminalBackground(hostTheme.theme.background)
    const polarityMatches =
      colorScheme === 'light' ? lightBg === true : lightBg === false || lightBg === null
    if (polarityMatches) {
      return hostTheme
    }
  }

  return {
    mode: colorScheme,
    theme: colorScheme === 'light' ? MOBILE_LIGHT_TERMINAL_THEME : MOBILE_DARK_TERMINAL_THEME,
    ...(minimumContrastRatio !== undefined ? { minimumContrastRatio } : {})
  }
}
