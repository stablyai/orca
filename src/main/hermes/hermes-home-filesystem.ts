import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ConfigParseResult, type HermesConfig, parseHermesConfig } from './hermes-config-yaml'
import { getHermesHome } from './hermes-default-home'
import { resolveHooksJsonWritePath } from '../agent-hooks/installation/configuration/hook-config-write-path'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import {
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

export function getConfigPath(home = getHermesHome()): string {
  return join(home, 'config.yaml')
}

export function getPluginDir(home = getHermesHome()): string {
  return join(home, 'plugins', HERMES_PLUGIN_NAME)
}

/** Named profiles (`hermes -p <name>`) that carry an Orca-managed copy of the plugin. */
export function listManagedProfileHomes(): string[] {
  const profilesDir = join(getHermesHome(), 'profiles')
  let names: string[]
  try {
    names = readdirSync(profilesDir)
  } catch {
    return []
  }
  return names
    .map((name) => join(profilesDir, name))
    .filter((home) => getPluginFilesState(getPluginDir(home)).managed)
}

function getManifestPath(pluginDir: string): string {
  return join(pluginDir, 'plugin.yaml')
}

function getInitPath(pluginDir: string): string {
  return join(pluginDir, '__init__.py')
}

type ConfigFileReadResult =
  | { ok: true; config: HermesConfig; content: string }
  | Extract<ConfigParseResult, { ok: false }>

export function readConfigFile(configPath: string): ConfigFileReadResult {
  const readPath = resolveHooksJsonWritePath(configPath)
  const content = existsSync(readPath) ? readFileSync(readPath, 'utf-8') : ''
  const parsed = parseHermesConfig(content)
  return parsed.ok ? { ...parsed, content } : parsed
}

export function writeConfigFile(configPath: string, content: string): void {
  writeHooksJson(configPath, {}, { serialized: content, preserveMode: true, defaultMode: 0o600 })
}

export const UNMANAGED_HERMES_PLUGIN_DETAIL =
  'Hermes orca-status plugin exists but is not Orca-managed'

function isNoEntryError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function getPluginFilesState(pluginDir = getPluginDir()): {
  present: boolean
  managed: boolean
  unmanaged: boolean
  error: boolean
  detail: string | null
} {
  let managedCount = 0
  let hasUnmanaged = false
  for (const filePath of [getManifestPath(pluginDir), getInitPath(pluginDir)]) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      if (content.includes(HERMES_PLUGIN_MARKER)) {
        managedCount += 1
      } else {
        hasUnmanaged = true
      }
    } catch (error) {
      if (!isNoEntryError(error)) {
        return {
          present: true,
          managed: false,
          unmanaged: false,
          error: true,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
  if (hasUnmanaged) {
    return {
      present: true,
      managed: false,
      unmanaged: true,
      error: false,
      detail: UNMANAGED_HERMES_PLUGIN_DETAIL
    }
  }
  if (managedCount === 2) {
    return { present: true, managed: true, unmanaged: false, error: false, detail: null }
  }
  return {
    present: false,
    managed: false,
    unmanaged: false,
    error: false,
    detail: 'Managed Hermes plugin files are missing'
  }
}

export function writePluginFiles(pluginDir = getPluginDir()): void {
  const state = getPluginFilesState(pluginDir)
  if (state.unmanaged || state.error) {
    throw new Error(state.detail ?? UNMANAGED_HERMES_PLUGIN_DETAIL)
  }
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(getManifestPath(pluginDir), getPluginManifest(), 'utf-8')
  writeFileSync(getInitPath(pluginDir), getPluginInitSource(), 'utf-8')
}
