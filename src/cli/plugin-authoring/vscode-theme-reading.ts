import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { PLUGIN_THEME_LIMIT } from '../../shared/plugins/contributions/plugin-content-pack-contributions'
import { isLightColor, parseHex } from './vscode-theme-color-math'

/** A VS Code color theme with every `include` flattened into it. */
export type VscodeTheme = {
  label: string
  base: 'light' | 'dark'
  colors: Record<string, string>
  tokenColors: unknown[]
}

export type VscodeThemeSet = {
  /** The extension's display name, when the source is an extension folder. */
  name?: string
  themes: VscodeTheme[]
  warnings: string[]
}

// Why bounded: an include chain is a handful of files; a cycle or a huge file is a broken input.
const MAX_INCLUDE_DEPTH = 8
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024
const MAX_TITLE_LENGTH = 128

export class VscodeThemeReadError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonc(file: string): unknown {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new VscodeThemeReadError(`${file} does not exist`)
  }
  if (statSync(file).size > MAX_THEME_FILE_BYTES) {
    throw new VscodeThemeReadError(`${file} is larger than 4 MiB`)
  }
  const errors: ParseError[] = []
  // Why JSONC: VS Code theme files routinely carry comments and trailing commas.
  const value: unknown = parseJsonc(readFileSync(file, 'utf8'), errors, {
    allowTrailingComma: true
  })
  if (errors.length > 0) {
    throw new VscodeThemeReadError(`${file} is not valid JSON`)
  }
  return value
}

/** A file the theme names, kept inside the imported folder after following symlinks. */
function containedFile(root: string, from: string, path: string): string {
  const target = resolve(dirname(from), path)
  const real = existsSync(target) ? realpathSync(target) : target
  const inside = relative(root, real)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new VscodeThemeReadError(`${path} points outside ${root}`)
  }
  return real
}

/** Plain text for a manifest title: no control, format (bidi, zero-width) characters. */
function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const title = value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
  return title || null
}

type ThemeFile = {
  name?: unknown
  type?: unknown
  colors: Record<string, string>
  tokenColors: unknown[]
}

function readThemeFile(
  root: string,
  file: string,
  warnings: string[],
  chain: readonly string[] = []
): ThemeFile {
  if (chain.includes(file) || chain.length >= MAX_INCLUDE_DEPTH) {
    throw new VscodeThemeReadError(`${basename(file)}: include chain is circular or too deep`)
  }
  const value = readJsonc(file)
  if (!isRecord(value)) {
    throw new VscodeThemeReadError(`${basename(file)} is not a color theme`)
  }
  const included: ThemeFile =
    typeof value.include === 'string'
      ? readThemeFile(root, containedFile(root, file, value.include), warnings, [...chain, file])
      : { colors: {}, tokenColors: [] }
  const colors = { ...included.colors }
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      // Why "default": VS Code reads it as "unset what an included theme set".
      if (color === 'default') {
        delete colors[key]
      } else if (typeof color === 'string') {
        colors[key] = color
      }
    }
  }
  // Why `settings` too: older themes keep their TextMate rules under that key.
  const rules = Array.isArray(value.tokenColors)
    ? value.tokenColors
    : Array.isArray(value.settings)
      ? value.settings
      : []
  if (typeof value.tokenColors === 'string') {
    warnings.push(
      `${basename(file)}: skipped tokenColors from ${value.tokenColors}; .tmTheme files are not read`
    )
  }
  if (value.semanticTokenColors !== undefined) {
    warnings.push(`${basename(file)}: dropped semanticTokenColors; Orca reads only tokenColors`)
  }
  return {
    name: value.name ?? included.name,
    type: value.type ?? included.type,
    colors,
    // Why included first: the including theme's rules come later and win, as in VS Code.
    tokenColors: [...included.tokenColors, ...rules]
  }
}

function declaredBase(type: unknown): 'light' | 'dark' | null {
  if (type === 'light' || type === 'hcLight' || type === 'vs' || type === 'hc-light') {
    return 'light'
  }
  if (type === 'dark' || type === 'hc' || type === 'vs-dark' || type === 'hc-black') {
    return 'dark'
  }
  return null
}

/** For an untyped theme: light when its editor background is; VS Code's own fallback is dark. */
function guessedBase(theme: ThemeFile): 'light' | 'dark' {
  const defaults = theme.tokenColors.find(
    (rule) => isRecord(rule) && rule.scope === undefined && isRecord(rule.settings)
  )
  const background =
    parseHex(theme.colors['editor.background']) ??
    (isRecord(defaults) && isRecord(defaults.settings)
      ? parseHex(defaults.settings.background)
      : null)
  return background && isLightColor(background) ? 'light' : 'dark'
}

function themeFrom(
  root: string,
  file: string,
  warnings: string[],
  contributed: { label?: unknown; uiTheme?: unknown } = {}
): VscodeTheme {
  const theme = readThemeFile(root, file, warnings)
  return {
    label: cleanTitle(contributed.label) ?? cleanTitle(theme.name) ?? basename(file, extname(file)),
    base: declaredBase(contributed.uiTheme) ?? declaredBase(theme.type) ?? guessedBase(theme),
    colors: theme.colors,
    tokenColors: theme.tokenColors
  }
}

/** Resolves `%key%` placeholders from the extension's package.nls.json. */
function nlsResolver(dir: string): (value: unknown) => unknown {
  const file = join(dir, 'package.nls.json')
  const strings = existsSync(file) ? readJsonc(file) : {}
  return (value) => {
    const key = typeof value === 'string' ? /^%(.+)%$/.exec(value)?.[1] : undefined
    if (key === undefined) {
      return value
    }
    const resolved = isRecord(strings) ? strings[key] : undefined
    return typeof resolved === 'string' ? resolved : null
  }
}

/** Reads a VS Code theme file, or every color theme an extension folder contributes. */
export function readVscodeThemes(source: string): VscodeThemeSet {
  const path = resolve(source)
  if (!existsSync(path)) {
    throw new VscodeThemeReadError(`${source} does not exist`)
  }
  const real = realpathSync(path)
  const warnings: string[] = []
  if (!statSync(real).isDirectory()) {
    return { themes: [themeFrom(dirname(real), real, warnings)], warnings }
  }
  const manifestFile = join(real, 'package.json')
  const pkg = readJsonc(manifestFile)
  const contributes = isRecord(pkg) && isRecord(pkg.contributes) ? pkg.contributes : {}
  const entries = (Array.isArray(contributes.themes) ? contributes.themes : []).filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.path === 'string'
  )
  const localized = nlsResolver(real)
  const themes: VscodeTheme[] = []
  for (const entry of entries) {
    const themePath = String(entry.path)
    if (themes.length === PLUGIN_THEME_LIMIT) {
      warnings.push(`kept the first ${PLUGIN_THEME_LIMIT} themes; a plugin holds at most that many`)
      break
    }
    if (extname(themePath).toLowerCase() !== '.json') {
      warnings.push(`${themePath}: skipped; only JSON color themes are read, not .tmTheme`)
      continue
    }
    try {
      const file = containedFile(real, manifestFile, themePath)
      themes.push(themeFrom(real, file, warnings, { ...entry, label: localized(entry.label) }))
    } catch (error) {
      if (!(error instanceof VscodeThemeReadError)) {
        throw error
      }
      warnings.push(`${themePath}: skipped; ${error.message}`)
    }
  }
  if (themes.length === 0) {
    throw new VscodeThemeReadError(`${manifestFile} contributes no readable JSON color themes`)
  }
  const name = isRecord(pkg) ? cleanTitle(localized(pkg.displayName)) : null
  return { ...(name ? { name } : {}), themes, warnings }
}
