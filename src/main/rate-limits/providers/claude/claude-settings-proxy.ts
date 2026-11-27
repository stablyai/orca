import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import {
  buildConfiguredProxyEnv,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../../../shared/network/network-proxy'
import { claudeManagedSettingsFile } from '../../../claude/configuration/claude-managed-settings-file'

const settingsEnvSchema = lazyZodSchema(() => z.object({ env: z.record(z.string(), z.unknown()) }))
// Claude Code's API proxy lookup (2.1.332): first set key wins; ALL_PROXY is not read.
const CLAUDE_PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const
const CLAUDE_PROXY_ENV_KEYS = new Set<string>([...CLAUDE_PROXY_KEYS, 'no_proxy', 'NO_PROXY'])

type Env = Record<string, string | undefined>

async function readSettingsEnv(path: string): Promise<Record<string, string>> {
  try {
    const env = settingsEnvSchema.safeParse(JSON.parse(await readFile(path, 'utf8'))).data?.env
    return Object.fromEntries(
      Object.entries(env ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

// Windows env names are case-insensitive, so a later layer's HTTPS_PROXY replaces an earlier https_proxy.
function proxyEnvKey(key: string): string {
  const lower = key.toLowerCase()
  return process.platform === 'win32' && CLAUDE_PROXY_ENV_KEYS.has(lower) ? lower : key
}

function layerEnv(...layers: Env[]): Env {
  const env: Env = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      env[proxyEnvKey(key)] = value
    }
  }
  return env
}

function resolveClaudeProxy(env: Env): NetworkProxySettings {
  const key = CLAUDE_PROXY_KEYS.find((name) => env[name])
  const { no_proxy: lower, NO_PROXY: upper } = env
  // Claude joins both spellings when they differ and splits the list on commas and whitespace.
  const bypass = lower && upper && lower !== upper ? `${lower},${upper}` : lower || upper
  return {
    httpProxyUrl: normalizeProxyUrl(key ? env[key] : '').value,
    httpProxyBypassRules: normalizeProxyBypassRules(bypass?.split(/[,\s]+/).join(','))
  }
}

/** The proxy Claude uses when its settings env changes it from what Orca launches it with; null keeps the app-wide path. */
export async function readClaudeSettingsProxy(
  configDir: string,
  networkProxySettings: NetworkProxySettings | undefined
): Promise<NetworkProxySettings | null> {
  const [userEnv, managedEnv] = await Promise.all([
    readSettingsEnv(join(configDir, 'settings.json')),
    readSettingsEnv(claudeManagedSettingsFile())
  ])
  const settingsEnv = layerEnv(userEnv, managedEnv)
  if (!Object.keys(settingsEnv).some((key) => CLAUDE_PROXY_ENV_KEYS.has(key))) {
    return null
  }
  // Claude applies settings env over the env Orca launches it with, managed settings last.
  // Read only the proxy names: spreading process.env costs O(n^2) getenv scans.
  const inheritedEnv = Object.fromEntries(
    [...CLAUDE_PROXY_ENV_KEYS].map((key) => [key, process.env[key]])
  )
  const launchEnv = layerEnv(inheritedEnv, buildConfiguredProxyEnv(networkProxySettings))
  const proxy = resolveClaudeProxy(layerEnv(launchEnv, settingsEnv))
  const inherited = resolveClaudeProxy(launchEnv)
  const unchanged =
    proxy.httpProxyUrl === inherited.httpProxyUrl &&
    proxy.httpProxyBypassRules === inherited.httpProxyBypassRules
  return proxy.httpProxyUrl && !unchanged ? proxy : null
}
