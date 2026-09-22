import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ConfigParseResult, HermesConfig } from './hermes-config-yaml'
import { parseHermesConfig, serializeHermesConfig } from './hermes-config-yaml'
import {
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

export function getHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERMES_HOME?.trim()
  return explicit ? explicit : join(homedir(), '.hermes')
}

export function getConfigPath(): string {
  return join(getHermesHome(), 'config.yaml')
}

export function getPluginDir(): string {
  return join(getHermesHome(), 'plugins', HERMES_PLUGIN_NAME)
}

function getManifestPath(pluginDir = getPluginDir()): string {
  return join(pluginDir, 'plugin.yaml')
}

function getInitPath(pluginDir = getPluginDir()): string {
  return join(pluginDir, '__init__.py')
}

export function readConfigFile(configPath: string): ConfigParseResult {
  if (!existsSync(configPath)) {
    return { ok: true, config: {} }
  }
  return parseHermesConfig(readFileSync(configPath, 'utf-8'))
}

export function writeConfigFile(configPath: string, config: HermesConfig): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const serialized = serializeHermesConfig(config)
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }

  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

export function getPluginFilesState(pluginDir = getPluginDir()): {
  present: boolean
  managed: boolean
  detail: string | null
} {
  const manifestPath = getManifestPath(pluginDir)
  const initPath = getInitPath(pluginDir)
  if (!existsSync(manifestPath) || !existsSync(initPath)) {
    return { present: false, managed: false, detail: 'Managed Hermes plugin files are missing' }
  }
  try {
    const manifest = readFileSync(manifestPath, 'utf-8')
    const init = readFileSync(initPath, 'utf-8')
    const managed = manifest.includes(HERMES_PLUGIN_MARKER) && init.includes(HERMES_PLUGIN_MARKER)
    return {
      present: true,
      managed,
      detail: managed ? null : 'Hermes orca-status plugin exists but is not Orca-managed'
    }
  } catch (error) {
    return {
      present: true,
      managed: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function writePluginFiles(pluginDir = getPluginDir()): void {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(getManifestPath(pluginDir), getPluginManifest(), 'utf-8')
  writeFileSync(getInitPath(pluginDir), getPluginInitSource(), 'utf-8')
}
