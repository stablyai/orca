import type {
  NativeTerminalAppearance,
  NativeTerminalTheme
} from '../../shared/native-terminal-appearance'

const PALETTE_KEYS: readonly (keyof NativeTerminalTheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

const GENERIC_FONT_FAMILIES = new Set([
  'monospace',
  'ui-monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'cursive',
  'fantasy',
  'emoji',
  'math',
  'fangsong'
])

// Ghostty scrollback is a byte budget, xterm's is lines; ~1 KB covers a styled row.
const SCROLLBACK_BYTES_PER_LINE = 1024
const MAX_SCROLLBACK_BYTES = 256 * 1024 * 1024

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
}

// Ghostty takes opaque #rrggbb; alpha is dropped because the pane background is opaque.
export function toGhosttyColor(color: unknown): string | null {
  if (typeof color !== 'string' || color.length === 0) {
    return null
  }
  const value = color.trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return `#${Array.from(digits.slice(0, 3), (d) => d + d).join('')}`.toLowerCase()
    }
    if (digits.length === 6 || digits.length === 8) {
      return `#${digits.slice(0, 6)}`.toLowerCase()
    }
    return null
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(value)
  if (rgb) {
    return `#${hexByte(Number(rgb[1]))}${hexByte(Number(rgb[2]))}${hexByte(Number(rgb[3]))}`
  }
  return null
}

export function toGhosttyFontFamilies(cssFontFamily: string): string[] {
  return configValue(cssFontFamily)
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter((family) => family.length > 0 && !GENERIC_FONT_FAMILIES.has(family.toLowerCase()))
}

// Values come from the renderer: a newline would let them append arbitrary config lines.
function configValue(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f && char !== '"'
    })
    .join('')
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function buildGhosttyConfig(
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): string {
  const zoom = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1
  const lines: string[] = [
    // Orca owns the shell, keybindings, OSC 52 and links; Ghostty only draws and encodes input.
    'keybind = clear',
    'shell-integration = none',
    'clipboard-read = deny',
    'clipboard-write = deny',
    'confirm-close-surface = false',
    'window-padding-balance = false',
    'link-url = true'
  ]

  lines.push(`window-padding-x = ${Math.max(0, Math.round(finite(appearance.paddingX, 0) * zoom))}`)
  lines.push(`window-padding-y = ${Math.max(0, Math.round(finite(appearance.paddingY, 0) * zoom))}`)
  lines.push('font-family = ')
  for (const family of toGhosttyFontFamilies(appearance.fontFamily)) {
    lines.push(`font-family = ${configValue(family)}`)
  }
  const fontSize = Math.max(1, finite(appearance.fontSize, 13) * zoom)
  lines.push(`font-size = ${Number(fontSize.toFixed(2))}`)
  const lineHeight = finite(appearance.lineHeight, 1)
  if (lineHeight > 1) {
    lines.push(`adjust-cell-height = ${Math.round((lineHeight - 1) * 100)}%`)
  }
  const letterSpacing = finite(appearance.letterSpacing, 0)
  if (letterSpacing !== 0) {
    lines.push(`adjust-cell-width = ${Math.round(letterSpacing * zoom)}`)
  }

  lines.push(
    `cursor-style = ${oneOf(appearance.cursorStyle, ['block', 'bar', 'underline'], 'block')}`
  )
  lines.push(`cursor-style-blink = ${appearance.cursorBlink === true}`)
  lines.push(
    `macos-option-as-alt = ${oneOf(appearance.macOptionAsAlt, ['true', 'false', 'left', 'right'], 'false')}`
  )
  lines.push(`bold-is-bright = ${appearance.drawBoldTextInBrightColors === true}`)
  lines.push(`mouse-hide-while-typing = ${appearance.mouseHideWhileTyping === true}`)
  lines.push(`copy-on-select = ${appearance.copyOnSelect === true ? 'clipboard' : 'false'}`)
  const minimumContrast = finite(appearance.minimumContrastRatio, 1)
  if (minimumContrast > 1) {
    lines.push(`minimum-contrast = ${Math.min(21, minimumContrast)}`)
  }
  const scrollbackBytes = Math.min(
    MAX_SCROLLBACK_BYTES,
    Math.max(0, Math.round(finite(appearance.scrollback, 1000))) * SCROLLBACK_BYTES_PER_LINE
  )
  lines.push(`scrollback-limit = ${scrollbackBytes}`)

  const { theme } = appearance
  const colorKeys: [string, string | undefined][] = [
    ['background', theme.background],
    ['foreground', theme.foreground],
    ['cursor-color', theme.cursor],
    ['cursor-text', theme.cursorAccent],
    ['selection-background', theme.selectionBackground],
    ['selection-foreground', theme.selectionForeground]
  ]
  for (const [key, color] of colorKeys) {
    const value = toGhosttyColor(color)
    if (value) {
      lines.push(`${key} = ${value}`)
    }
  }
  PALETTE_KEYS.forEach((key, index) => {
    const value = toGhosttyColor(theme[key])
    if (value) {
      lines.push(`palette = ${index}=${value}`)
    }
  })

  return `${lines.join('\n')}\n`
}
