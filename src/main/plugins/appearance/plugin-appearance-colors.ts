import { createHash } from 'node:crypto'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { TERMINAL_COLOR_OVERRIDES_SETTING } from '../../../shared/terminal-themes/terminal-color-overrides'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  parsePluginAppThemeArtifact,
  type PluginThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import {
  parsePluginTerminalThemeArtifact,
  type PluginTerminalThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { PluginHostCallError } from '../workers/plugin-host-call-scope'

export type PluginAppearanceColors = { app: string; terminal: string }
export type PreparedPluginAppearance = {
  app: PluginThemeRegistration
  terminal: PluginTerminalThemeRegistration
  settings: Partial<GlobalSettings>
}

export function preparePluginAppearanceColors(
  pluginKey: string,
  pluginName: string,
  input: PluginAppearanceColors,
  current: GlobalSettings
): PreparedPluginAppearance {
  if (!isQualifiedPluginKey(pluginKey)) {
    throw new PluginHostCallError('invalid_params', 'invalid appearance owner')
  }
  if (Buffer.byteLength(input.app) > 16 * 1024 || Buffer.byteLength(input.terminal) > 16 * 1024) {
    throw new PluginHostCallError('too_large', 'appearance artifact exceeds 16 KiB')
  }
  let app
  let terminal
  try {
    app = parsePluginAppThemeArtifact(input.app, 'strict')
    terminal = parsePluginTerminalThemeArtifact(input.terminal, 'strict')
  } catch {
    throw new PluginHostCallError('invalid_params', 'invalid appearance artifact')
  }
  if (app.background) {
    throw new PluginHostCallError('invalid_params', 'runtime backgrounds are not supported')
  }
  if (terminal.mode !== app.base) {
    throw new PluginHostCallError('invalid_params', 'app and terminal appearance modes differ')
  }
  const slot = app.base === 'dark' ? 'Dark' : 'Light'
  const id = `plugin:${pluginKey}/runtime-${app.base}` as const
  const selected = new Set([
    slot === 'Dark' ? id : current.terminalThemeDark,
    slot === 'Light' ? id : current.terminalThemeLight
  ])
  const palettes = (current.terminalPluginPalettes ?? []).filter(
    (entry) => entry.id !== id && selected.has(entry.id)
  )
  const registration = { id, pluginKey, pluginName, label: `${pluginName} (${app.base})` }
  return {
    app: {
      ...app,
      ...registration,
      revision: createHash('sha256').update(input.app).digest('hex').slice(0, 32)
    },
    terminal: { ...terminal, ...registration },
    settings: {
      theme: app.base,
      [`pluginAppTheme${slot}`]: id,
      [`editorTheme${slot}`]: id,
      [`terminalTheme${slot}`]: id,
      terminalUseSeparateLightTheme: true,
      [TERMINAL_COLOR_OVERRIDES_SETTING[app.base]]: undefined,
      terminalPluginPalettes: [...palettes, { id, colors: terminal.terminal }]
    }
  }
}
