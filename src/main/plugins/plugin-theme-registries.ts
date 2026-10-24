import { createHash } from 'node:crypto'
import type { PluginThemeContribution } from '../../shared/plugins/plugin-content-pack-contributions'
import {
  parsePluginAppThemeArtifact,
  type PluginThemeRegistration
} from '../../shared/plugins/plugin-theme-artifact'
import {
  parsePluginTerminalThemeArtifact,
  type PluginTerminalThemeRegistration
} from '../../shared/plugins/plugin-terminal-theme-artifact'
import {
  PLUGIN_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

async function readTheme<T>(
  plugin: ValidDiscoveredPlugin,
  contribution: PluginThemeContribution,
  kind: string,
  parse: (text: string) => T
): Promise<
  T & {
    id: `plugin:${string}`
    revision: string
    pluginKey: string
    pluginName: string
    label: string
  }
> {
  const text = await readContainedPluginArtifactText(
    plugin.rootDir,
    contribution.path,
    PLUGIN_THEME_MAX_BYTES
  )
  try {
    return {
      ...parse(text),
      id: `plugin:${plugin.pluginKey}/${contribution.id}`,
      revision: createHash('sha256').update(text).digest('hex').slice(0, 32),
      pluginKey: plugin.pluginKey,
      pluginName: plugin.manifest.name,
      label: contribution.label
    }
  } catch (error) {
    throw new Error(
      `${kind} "${contribution.id}" is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function createPluginThemeRegistry(contentVerifier: PluginContentVerifier) {
  return new PluginArtifactPackRegistry<PluginThemeContribution, PluginThemeRegistration>({
    contentVerifier,
    contributions: (plugin) => plugin.manifest.contributes.themes,
    load: (plugin, contribution) =>
      readTheme(plugin, contribution, 'theme', parsePluginAppThemeArtifact)
  })
}

export function createPluginTerminalThemeRegistry(contentVerifier: PluginContentVerifier) {
  return new PluginArtifactPackRegistry<PluginThemeContribution, PluginTerminalThemeRegistration>({
    contentVerifier,
    contributions: (plugin) => plugin.manifest.contributes.terminalThemes,
    load: (plugin, contribution) =>
      readTheme(plugin, contribution, 'terminal theme', parsePluginTerminalThemeArtifact)
  })
}
