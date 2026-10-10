import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { ConfigParseResult, HermesConfig } from './hermes-config-yaml'
import { parseHermesConfig } from './hermes-config-yaml'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { writeHooksJson } from '../agent-hooks/installer-utils'
import {
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

const HERMES_HOME_MAX_LENGTH = 32_768

type DefaultHermesHomeOptions = {
  homeDir?: string
  platform?: NodeJS.Platform
  directoryExists?: (candidate: string) => boolean
}

function normalizedAbsolute(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > HERMES_HOME_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

function isDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
}

/** Hermes home when `HERMES_HOME` is unset. Matches skill discovery's default root. */
export function resolveDefaultHermesHome(
  env: NodeJS.ProcessEnv = process.env,
  options: DefaultHermesHomeOptions = {}
): string {
  const homeDir = options.homeDir ?? homedir()
  const dotfolderHome = join(homeDir, '.hermes')
  if ((options.platform ?? process.platform) !== 'win32') {
    return dotfolderHome
  }
  const localAppData = normalizedAbsolute(env.LOCALAPPDATA)
  if (!localAppData) {
    return dotfolderHome
  }
  const localAppDataHome = join(localAppData, 'hermes')
  const directoryExists = options.directoryExists ?? isDirectory
  // Why: a pre-LOCALAPPDATA install stays at ~/.hermes when that is the only tree (#24966).
  return !directoryExists(localAppDataHome) && directoryExists(dotfolderHome)
    ? dotfolderHome
    : localAppDataHome
}

export function getHermesHome(
  env: NodeJS.ProcessEnv = process.env,
  options: DefaultHermesHomeOptions = {}
): string {
  const explicit = env.HERMES_HOME?.trim()
  // Why: an explicit profile still wins. The Windows default matches skill discovery so hook
  // status does not report not_installed for %LOCALAPPDATA%\hermes (#24966).
  return explicit ? explicit : resolveDefaultHermesHome(env, options)
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
