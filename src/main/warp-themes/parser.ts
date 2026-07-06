import path from 'node:path'
import { parseDocument } from 'yaml'
import type { TerminalColorOverrides } from '../../shared/types'
import {
  hasUsableTerminalThemeColors,
  makeCustomTerminalThemeSelection,
  normalizeTerminalHexColor,
  normalizeTerminalThemeId,
  normalizeTerminalThemeName,
  type TerminalCustomTheme,
  type TerminalCustomThemeMode,
  type WarpThemeImportPreviewTheme
} from '../../shared/terminal-custom-themes'

const WARP_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
] as const

const MAX_PARSE_MS = 1_000

const NORMAL_COLOR_KEYS = {
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white'
} as const satisfies Record<(typeof WARP_COLOR_NAMES)[number], keyof TerminalColorOverrides>

const BRIGHT_COLOR_KEYS = {
  black: 'brightBlack',
  red: 'brightRed',
  green: 'brightGreen',
  yellow: 'brightYellow',
  blue: 'brightBlue',
  magenta: 'brightMagenta',
  cyan: 'brightCyan',
  white: 'brightWhite'
} as const satisfies Record<(typeof WARP_COLOR_NAMES)[number], keyof TerminalColorOverrides>

export type ParsedWarpThemeResult =
  | { ok: true; theme: WarpThemeImportPreviewTheme }
  | { ok: false; reason: string }

export type ParseWarpThemeOptions = {
  idDiscriminator?: string
  idSuffix?: string
  importedAt?: string
  sourceLabel?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readColorValue(value: unknown): string | null {
  const scalar = normalizeTerminalHexColor(value)
  if (scalar) {
    return scalar
  }
  if (!isRecord(value)) {
    return null
  }
  return (
    normalizeTerminalHexColor(value.top) ??
    normalizeTerminalHexColor(value.bottom) ??
    normalizeTerminalHexColor(value.left) ??
    normalizeTerminalHexColor(value.right)
  )
}

function readColor(input: Record<string, unknown>, key: string): string | null {
  return readColorValue(input[key])
}

function addWarpPalette(
  terminal: TerminalColorOverrides,
  palette: unknown,
  keys: Record<(typeof WARP_COLOR_NAMES)[number], keyof TerminalColorOverrides>
): void {
  if (!isRecord(palette)) {
    return
  }
  for (const name of WARP_COLOR_NAMES) {
    const color = normalizeTerminalHexColor(palette[name])
    if (color) {
      terminal[keys[name]] = color
    }
  }
}

function luminance(hexColor: string): number {
  const hex = hexColor.slice(1)
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function inferMode(background: string | undefined, details: unknown): TerminalCustomThemeMode {
  if (background) {
    return luminance(background) >= 0.55 ? 'light' : 'dark'
  }
  if (details === 'lighter') {
    return 'light'
  }
  if (details === 'darker') {
    return 'dark'
  }
  return 'unknown'
}

function detectUnsupportedFeatures(input: Record<string, unknown>): string[] | undefined {
  const unsupported = new Set<string>()
  if ('background_image' in input) {
    unsupported.add('background image not supported')
  }
  if (isRecord(input.background)) {
    unsupported.add('background gradient not supported')
  }
  if (isRecord(input.accent)) {
    unsupported.add('accent gradient not supported')
  }
  if ('background_gradient' in input || 'gradient' in input || 'gradients' in input) {
    unsupported.add('gradient not supported')
  }
  return unsupported.size > 0 ? [...unsupported] : undefined
}

export function parseWarpThemeYaml(
  content: string,
  fileLabel: string,
  options: ParseWarpThemeOptions = {}
): ParsedWarpThemeResult {
  let value: unknown
  const parseStartedAt = Date.now()
  const parseTimedOut = (): boolean => Date.now() - parseStartedAt > MAX_PARSE_MS
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (parseTimedOut()) {
      return { ok: false, reason: 'Theme file took too long to parse.' }
    }
    if (document.errors.length > 0) {
      return { ok: false, reason: document.errors[0]?.message ?? 'Invalid YAML' }
    }
    // Why: cap alias expansion so a malicious YAML alias bomb can't blow up memory.
    value = document.toJS({ maxAliasCount: 20 })
    if (parseTimedOut()) {
      return { ok: false, reason: 'Theme file took too long to parse.' }
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid YAML'
    }
  }

  if (!isRecord(value)) {
    return { ok: false, reason: 'Theme file must contain a YAML object.' }
  }

  const fallbackName = path.basename(fileLabel, path.extname(fileLabel))
  const name = normalizeTerminalThemeName(value.name, fallbackName)
  const terminal: TerminalColorOverrides = {}
  const background = readColor(value, 'background')
  const foreground = readColor(value, 'foreground')
  const cursor = readColor(value, 'cursor') ?? readColor(value, 'accent')

  if (background) {
    terminal.background = background
  }
  if (foreground) {
    terminal.foreground = foreground
  }
  if (cursor) {
    terminal.cursor = cursor
  }

  const terminalColors = isRecord(value.terminal_colors) ? value.terminal_colors : {}
  addWarpPalette(terminal, terminalColors.normal, NORMAL_COLOR_KEYS)
  addWarpPalette(terminal, terminalColors.bright, BRIGHT_COLOR_KEYS)

  if (!hasUsableTerminalThemeColors(terminal)) {
    return {
      ok: false,
      reason: 'Theme must include background, foreground, and at least one ANSI color.'
    }
  }

  const safeDiscriminator = normalizeTerminalThemeId(options.idDiscriminator, '')
  const idBase = normalizeTerminalThemeId(
    safeDiscriminator ? `warp:${name}:${safeDiscriminator}` : `warp:${name}`
  )
  const id = options.idSuffix ? `${idBase}-${options.idSuffix}` : idBase
  const unsupportedFeatures = detectUnsupportedFeatures(value)
  const theme: TerminalCustomTheme = {
    id,
    name,
    source: 'warp',
    mode: inferMode(background ?? undefined, value.details),
    terminal,
    importedAt: options.importedAt ?? new Date().toISOString(),
    sourceLabel: options.sourceLabel ?? fileLabel,
    ...(unsupportedFeatures ? { unsupportedFeatures } : {})
  }

  return {
    ok: true,
    theme: {
      ...theme,
      selectionValue: makeCustomTerminalThemeSelection(theme.id)
    }
  }
}
