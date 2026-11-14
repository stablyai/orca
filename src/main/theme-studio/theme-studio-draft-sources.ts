import type { PluginThemeRegistration } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import { isThemeColorValue } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { normalizeTerminalColorOverrides } from '../../shared/terminal-themes/terminal-custom-themes'
import type {
  ThemeStudioDraft,
  ThemeStudioMode,
  ThemeStudioVariant
} from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioResolveResult,
  ThemeStudioResolvedMode
} from '../../shared/theme-studio/theme-studio-protocol'

const DEFAULT_DRAFT_NAME = 'My Theme'

/** Where a draft starts: its first undo step is named by `label`. */
export type StartedDraft = { draft: ThemeStudioDraft; label: string }

export type InstalledThemes = {
  themes: readonly PluginThemeRegistration[]
  terminalThemes: readonly PluginTerminalThemeRegistration[]
}

function variantFromResolved(resolved: ThemeStudioResolvedMode): ThemeStudioVariant {
  const tokens = Object.fromEntries(
    Object.entries(resolved.tokens).flatMap(([token, { value }]) => (value ? [[token, value]] : []))
  )
  if (!tokens['--background'] || !tokens['--foreground']) {
    throw new Error(`Orca could not read its ${resolved.mode} colors.`)
  }
  const terminal = normalizeTerminalColorOverrides(resolved.terminal)
  return {
    tokens,
    ...(resolved.tokenColors?.length ? { tokenColors: resolved.tokenColors } : {}),
    ...(Object.keys(terminal).length ? { terminal } : {})
  }
}

export function withName(draft: ThemeStudioDraft, name: string | undefined): ThemeStudioDraft {
  return name ? { ...draft, name } : draft
}

/** A draft of exactly what the window paints now for each mode. */
export function draftFromResolved(resolved: ThemeStudioResolveResult, name?: string): StartedDraft {
  const byMode = new Map(resolved.modes.map((mode) => [mode.mode, mode]))
  const shown = byMode.get(resolved.shownMode)
  const variant = (mode: ThemeStudioMode): ThemeStudioVariant | null => {
    const entry = byMode.get(mode)
    return entry ? variantFromResolved(entry) : null
  }
  // Why the plugin's own name: applying then replaces the theme that was edited.
  const themeName = shown?.themeName ?? null
  return {
    draft: {
      name: name ?? themeName ?? DEFAULT_DRAFT_NAME,
      light: variant('light'),
      dark: variant('dark')
    },
    label: `Start from ${shown?.themeLabel ?? 'Orca'}`
  }
}

export function draftFromInstalled(
  { themes, terminalThemes }: InstalledThemes,
  target: string,
  name?: string
): StartedDraft {
  const matches = themes.filter((theme) => theme.id === target || theme.pluginKey === target)
  if (matches.length === 0) {
    throw new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `No installed theme ${target}.`, {
      nextSteps: ['Run `orca theme show --json` for the themes in use, or `orca plugin list`.']
    })
  }
  const variant = (mode: ThemeStudioMode): ThemeStudioVariant | null => {
    const theme = matches.find((entry) => entry.base === mode)
    if (!theme) {
      return null
    }
    const palette = terminalThemes.find(
      (entry) => entry.pluginKey === theme.pluginKey && entry.mode === mode
    )
    return {
      // Why only plain colors: the rest are derivations Orca fills again when it loads the theme.
      tokens: Object.fromEntries(
        Object.entries(theme.tokens).filter(([, value]) => isThemeColorValue(value))
      ),
      ...(theme.tokenColors?.length ? { tokenColors: theme.tokenColors } : {}),
      ...(palette ? { terminal: { ...palette.terminal } } : {})
    }
  }
  const label = matches[0].pluginName
  return {
    draft: { name: name ?? label, light: variant('light'), dark: variant('dark') },
    label: `Start from ${label}`
  }
}
