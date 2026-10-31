import { PLUGIN_THEME_MAX_BYTES } from '../../main/plugins/plugin-artifact-validation'
import type { PluginThemeTokenColorRule } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import {
  hasUsableTerminalThemeColors,
  TERMINAL_COLOR_KEYS
} from '../../shared/terminal-custom-themes'
import type { TerminalColorOverrides } from '../../shared/terminal-color-overrides'
import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'
import {
  TRANSLUCENT_APP_THEME_TOKENS,
  VSCODE_APP_THEME_COLORS,
  VSCODE_TERMINAL_COLORS
} from './vscode-theme-color-map'
import { contrastRatio, flatten, parseHex, toHex, type Rgba } from './vscode-theme-color-math'
import { isRecord, type VscodeTheme, type VscodeThemeSet } from './vscode-theme-reading'

// Why: VS Code's own defaults when a theme leaves the editor colors out.
const DEFAULT_EDITOR: Record<'light' | 'dark', { background: Rgba; foreground: Rgba }> = {
  light: { background: [255, 255, 255, 1], foreground: [0, 0, 0, 1] },
  dark: { background: [30, 30, 30, 1], foreground: [212, 212, 212, 1] }
}
// Orca's strict theme schema: rules, scopes per rule and characters per scope.
const MAX_SCOPES_PER_RULE = 64
const MAX_RULES = 512
const MAX_SCOPE_LENGTH = 512
// Why 48: room for a `-2` suffix and the `-terminal` id within the 64-character id limit.
const MAX_ID_BASE_LENGTH = 48
const RESERVED_IDS = new Set(['prototype', 'constructor'])
const FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough'])

function firstColor(colors: Record<string, string>, keys: readonly string[]): Rgba | null {
  for (const key of keys) {
    const color = parseHex(colors[key])
    if (color) {
      return color
    }
  }
  return null
}

/** The scope-less rule VS Code themes use for the editor's default text and background. */
function defaultRuleSettings(theme: VscodeTheme): Record<string, unknown> {
  const rule = theme.tokenColors.find(
    (entry) => isRecord(entry) && entry.scope === undefined && isRecord(entry.settings)
  )
  return isRecord(rule) && isRecord(rule.settings) ? rule.settings : {}
}

function editorColors(theme: VscodeTheme): { background: Rgba; foreground: Rgba } {
  const fallback = defaultRuleSettings(theme)
  const defaults = DEFAULT_EDITOR[theme.base]
  const background = flatten(
    firstColor(theme.colors, ['editor.background']) ??
      parseHex(fallback.background) ??
      defaults.background,
    defaults.background
  )
  const foreground =
    firstColor(theme.colors, ['editor.foreground', 'foreground']) ??
    parseHex(fallback.foreground) ??
    defaults.foreground
  return { background, foreground: flatten(foreground, background) }
}

function appTokens(theme: VscodeTheme): Record<string, string> {
  const { background, foreground } = editorColors(theme)
  const colors = {
    ...theme.colors,
    'editor.background': toHex(background),
    'editor.foreground': toHex(foreground)
  }
  const tokens: Record<string, string> = {}
  for (const [token, keys] of Object.entries(VSCODE_APP_THEME_COLORS)) {
    const color = keys ? firstColor(colors, keys) : null
    if (color) {
      // Why flatten: Orca needs opaque text and surfaces to check their contrast.
      tokens[token] = toHex(
        TRANSLUCENT_APP_THEME_TOKENS.has(token) ? color : flatten(color, background)
      )
    }
  }
  return withoutUnreadableText(tokens)
}

/** The surfaces a text token is read on: `--x-foreground` on `--x`, body text on the canvas. */
function surfacesOf(token: string): string[] {
  if (token === '--foreground' || token === '--muted-foreground') {
    return [
      '--background',
      '--editor-surface',
      ...(token === '--muted-foreground' ? ['--muted'] : [])
    ]
  }
  return token.endsWith('-foreground') ? [token.slice(0, -'-foreground'.length)] : []
}

const MIN_TEXT_CONTRAST = 4.5

function readableOn(text: Rgba, token: string, tokens: Record<string, string>): boolean {
  return surfacesOf(token).every((surface) => {
    const color = parseHex(tokens[surface])
    return !color || contrastRatio(text, color) >= MIN_TEXT_CONTRAST
  })
}

/** The dimmest mix of `--foreground` into `--background` that stays readable. */
function readableMutedText(tokens: Record<string, string>): string | null {
  const foreground = parseHex(tokens['--foreground'])
  const background = parseHex(tokens['--background'])
  if (!foreground || !background) {
    return null
  }
  for (let share = 0.7; share <= 1; share += 0.05) {
    const mix = flatten([foreground[0], foreground[1], foreground[2], share], background)
    if (readableOn(mix, '--muted-foreground', tokens)) {
      return toHex(mix)
    }
  }
  return null
}

/**
 * Orca drops both colors of a text/surface pair under 4.5:1, which would lose the surface too.
 * VS Code themes often use dim description text, so an unreadable text token is left to Orca's
 * derivation, and muted text (whose derived 70% mix can also fail) gets the dimmest readable mix.
 */
function withoutUnreadableText(tokens: Record<string, string>): Record<string, string> {
  const readable = { ...tokens }
  for (const token of Object.keys(tokens)) {
    const text = parseHex(tokens[token])
    if (token !== '--foreground' && text && !readableOn(text, token, tokens)) {
      delete readable[token]
    }
  }
  if (!readable['--muted-foreground']) {
    const muted = readableMutedText(readable)
    if (muted) {
      readable['--muted-foreground'] = muted
    }
  }
  return readable
}

function scopesOf(scope: unknown): string[] {
  const list = Array.isArray(scope) ? scope : [scope]
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * VS Code rules in the shape Orca validates: one rule per distinct style, each scope once with
 * its last style (later rules win, as in VS Code). Descendant selectors (`a b`) are dropped
 * because Orca does not read them.
 */
export function compactTokenColors(
  tokenColors: readonly unknown[],
  warnings: string[],
  label: string
): PluginThemeTokenColorRule[] {
  const byScope = new Map<string, { foreground?: string; fontStyle?: string }>()
  let descendant = 0
  for (const rule of tokenColors) {
    if (!isRecord(rule) || !isRecord(rule.settings)) {
      continue
    }
    const foreground = parseHex(rule.settings.foreground)
    const fontStyle =
      typeof rule.settings.fontStyle === 'string'
        ? rule.settings.fontStyle
            .split(/\s+/)
            .filter((style) => FONT_STYLES.has(style))
            .join(' ')
        : undefined
    if (!foreground && fontStyle === undefined) {
      continue
    }
    for (const scope of scopesOf(rule.scope)) {
      if (/\s/.test(scope)) {
        descendant += 1
        continue
      }
      if (scope.length > MAX_SCOPE_LENGTH) {
        continue
      }
      byScope.set(scope, {
        ...byScope.get(scope),
        ...(foreground ? { foreground: toHex(foreground) } : {}),
        ...(fontStyle !== undefined ? { fontStyle } : {})
      })
    }
  }
  if (descendant > 0) {
    warnings.push(`${label}: dropped ${descendant} descendant scope selectors Orca does not read`)
  }
  const byStyle = new Map<
    string,
    { settings: PluginThemeTokenColorRule['settings']; scopes: string[] }
  >()
  for (const [scope, settings] of byScope) {
    const key = JSON.stringify([settings.foreground, settings.fontStyle])
    const group = byStyle.get(key) ?? { settings, scopes: [] }
    group.scopes.push(scope)
    byStyle.set(key, group)
  }
  return [...byStyle.values()].flatMap(({ settings, scopes }) => {
    const rules: PluginThemeTokenColorRule[] = []
    for (let index = 0; index < scopes.length; index += MAX_SCOPES_PER_RULE) {
      const chunk = scopes.slice(index, index + MAX_SCOPES_PER_RULE)
      rules.push({ scope: chunk.length === 1 ? chunk[0] : chunk, settings })
    }
    return rules
  })
}

function appThemeFile(theme: VscodeTheme, warnings: string[]): string {
  const tokens = appTokens(theme)
  const rules = compactTokenColors(theme.tokenColors, warnings, theme.label)
  const fits = (text: string): boolean => Buffer.byteLength(text) <= PLUGIN_THEME_MAX_BYTES
  // Why minify before trimming: Orca caps a theme file at 16 KiB and code colors are most of it.
  const render = (kept: number): string => {
    const tokenColors = rules.slice(0, kept)
    const content = { schemaVersion: 1, base: theme.base, tokens, ...(kept ? { tokenColors } : {}) }
    const pretty = json(content)
    return fits(pretty) ? pretty : `${JSON.stringify(content)}\n`
  }
  // Rules keep the order their style first appears in the theme, so the last are dropped first.
  let low = 0
  let high = Math.min(rules.length, MAX_RULES)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(render(middle))) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  if (low < rules.length) {
    warnings.push(
      `${theme.label}: kept ${low} of ${rules.length} code color rules to fit Orca's theme limits`
    )
  }
  return render(low)
}

function terminalPalette(theme: VscodeTheme): TerminalColorOverrides | null {
  const editor = editorColors(theme)
  const background = flatten(
    firstColor(theme.colors, VSCODE_TERMINAL_COLORS.background) ?? editor.background,
    editor.background
  )
  const fallbacks: Partial<Record<keyof TerminalColorOverrides, Rgba>> = {
    background,
    foreground: editor.foreground
  }
  const palette: TerminalColorOverrides = {}
  for (const key of TERMINAL_COLOR_KEYS) {
    const color =
      key === 'background'
        ? background
        : (firstColor(theme.colors, VSCODE_TERMINAL_COLORS[key]) ?? fallbacks[key])
    if (color) {
      // Why flatten: terminal palettes are opaque hex; VS Code paints alpha over the panel.
      palette[key] = toHex(flatten(color, background))
    }
  }
  return hasUsableTerminalThemeColors(palette) ? palette : null
}

function slug(label: string, taken: Set<string>): string {
  const cut = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_ID_BASE_LENGTH)
    .replace(/^-+|-+$/g, '')
  const base = !cut ? 'theme' : RESERVED_IDS.has(cut) ? `${cut}-theme` : cut
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`
  }
  taken.add(id)
  return id
}

/** An Orca plugin holding an app theme for every VS Code theme, plus its terminal palette. */
export function renderVscodeThemePlugin(
  set: VscodeThemeSet,
  identity: PluginTemplateInput
): PluginTemplate & { warnings: string[] } {
  const warnings = [...set.warnings]
  const files: Record<string, string> = {}
  const themes: { id: string; title: string; path: string }[] = []
  const terminalThemes: { id: string; title: string; path: string }[] = []
  const taken = new Set<string>()
  for (const theme of set.themes) {
    const id = slug(theme.label, taken)
    files[`themes/${id}.json`] = appThemeFile(theme, warnings)
    themes.push({ id, title: theme.label, path: `themes/${id}.json` })
    const palette = terminalPalette(theme)
    if (palette) {
      files[`terminal/${id}.json`] = json({ schemaVersion: 1, mode: theme.base, terminal: palette })
      terminalThemes.push({ id: `${id}-terminal`, title: theme.label, path: `terminal/${id}.json` })
    } else {
      warnings.push(`${theme.label}: no terminal palette; it sets no terminal.ansi* colors`)
    }
  }
  const description = `${identity.name}, imported from a VS Code color theme.`
  return {
    description,
    warnings: [...new Set(warnings)],
    files: {
      'orca-plugin.json': manifest(identity, description, {
        execution: 'data',
        contributes: { themes, ...(terminalThemes.length ? { terminalThemes } : {}) }
      }),
      ...files,
      'README.md': readme(
        identity,
        'Imported with `orca plugin import-vscode-theme`. Check the license of the original theme before publishing; keep its notice with these files.'
      ),
      ...COMMON_FILES
    }
  }
}
