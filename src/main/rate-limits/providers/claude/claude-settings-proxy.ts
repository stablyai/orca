import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  type NetworkProxySettings
} from '../../../../shared/network/network-proxy'

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Claude applies settings.json `env` over its inherited env, so this is the proxy the account itself uses. */
export async function readClaudeSettingsProxy(
  configDir: string
): Promise<NetworkProxySettings | null> {
  let settings: unknown
  try {
    settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
  } catch {
    return null
  }
  const env = isJsonObject(settings) ? settings.env : undefined
  if (!isJsonObject(env)) {
    return null
  }
  const values = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const proxy = getProxyUrlFromEnvironment(values)
  if (!proxy.ok || !proxy.value) {
    return null
  }
  return {
    httpProxyUrl: proxy.value,
    httpProxyBypassRules: getProxyBypassRulesFromEnvironment(values)
  }
}
