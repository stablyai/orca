import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { isZhipuUsageHost, normalizeZhipuBaseUrl } from '../../shared/zhipu-usage'

const CC_SWITCH_DB_FILE = 'cc-switch.db'
const CC_SWITCH_SETTINGS_FILE = 'settings.json'

type CcSwitchSettings = {
  currentProviderClaude?: unknown
}

type CcSwitchProviderRow = {
  settings_config?: unknown
}

type CcSwitchProviderConfig = {
  env?: unknown
}

export type CcSwitchZhipuCredentialsImport = {
  providerName: string
  baseUrl: string
  authToken: string
}

export type ReadCcSwitchZhipuCredentialsOptions = {
  ccSwitchDir?: string
}

function getCcSwitchDir(options?: ReadCcSwitchZhipuCredentialsOptions): string {
  return options?.ccSwitchDir ?? join(homedir(), '.cc-switch')
}

function readCurrentClaudeProviderName(settingsPath: string): string {
  if (!existsSync(settingsPath)) {
    throw new Error('cc-switch settings were not found.')
  }
  let settings: CcSwitchSettings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as CcSwitchSettings
  } catch {
    throw new Error('cc-switch settings could not be read.')
  }
  const providerName =
    typeof settings.currentProviderClaude === 'string' ? settings.currentProviderClaude.trim() : ''
  return providerName || 'default'
}

function parseProviderConfig(value: unknown): CcSwitchProviderConfig {
  if (typeof value !== 'string') {
    throw new Error('Current cc-switch Claude provider has no settings_config.')
  }
  try {
    const parsed = JSON.parse(value) as CcSwitchProviderConfig
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    throw new Error('Current cc-switch Claude provider has invalid settings_config.')
  }
}

function readProviderEnvValue(config: CcSwitchProviderConfig, key: string): string {
  if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
    return ''
  }
  const value = (config.env as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

function assertZhipuBaseUrl(baseUrl: string): string {
  if (!baseUrl.trim()) {
    throw new Error('Current cc-switch Claude provider is missing ANTHROPIC_BASE_URL.')
  }
  const normalized = normalizeZhipuBaseUrl(baseUrl)
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('Current cc-switch Claude provider has an invalid ANTHROPIC_BASE_URL.')
  }
  if (!isZhipuUsageHost(url.host)) {
    throw new Error('Current cc-switch Claude provider is not a Zhipu / Z.AI endpoint.')
  }
  return normalized
}

function readCurrentProviderConfig(dbPath: string, providerName: string): CcSwitchProviderConfig {
  if (!existsSync(dbPath)) {
    throw new Error('cc-switch database was not found.')
  }
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const row = db
      .prepare("SELECT settings_config FROM providers WHERE app_type = 'claude' AND name = ?")
      .get(providerName) as CcSwitchProviderRow | undefined
    if (!row) {
      throw new Error('Current cc-switch Claude provider was not found.')
    }
    return parseProviderConfig(row.settings_config)
  } finally {
    db.close()
  }
}

export function readCcSwitchZhipuCredentials(
  options?: ReadCcSwitchZhipuCredentialsOptions
): CcSwitchZhipuCredentialsImport {
  const ccSwitchDir = getCcSwitchDir(options)
  const providerName = readCurrentClaudeProviderName(join(ccSwitchDir, CC_SWITCH_SETTINGS_FILE))
  const config = readCurrentProviderConfig(join(ccSwitchDir, CC_SWITCH_DB_FILE), providerName)
  const baseUrl = assertZhipuBaseUrl(readProviderEnvValue(config, 'ANTHROPIC_BASE_URL'))
  const authToken = readProviderEnvValue(config, 'ANTHROPIC_AUTH_TOKEN')
  if (!authToken) {
    throw new Error('Current cc-switch Claude provider is missing ANTHROPIC_AUTH_TOKEN.')
  }
  return {
    providerName,
    baseUrl,
    authToken
  }
}
