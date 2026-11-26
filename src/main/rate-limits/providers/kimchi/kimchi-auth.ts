import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KIMCHI_API_BASE_URLS = {
  us: 'https://api.cast.ai',
  eu: 'https://api.eu.cast.ai'
} as const

export type KimchiUsageAuth = {
  apiKey: string
  apiBaseUrl: string
  credentialSource: 'environment' | 'config'
  authProvenance: string
}

export type KimchiUsageAuthReadResult =
  | { status: 'ok'; auth: KimchiUsageAuth }
  | { status: 'missing' | 'error' | 'unsupported'; error: string }

type KimchiAuthOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
}

function authFingerprint(apiKey: string, apiBaseUrl: string): string {
  return createHash('sha256')
    .update(apiBaseUrl)
    .update('\0')
    .update(apiKey)
    .digest('hex')
    .slice(0, 16)
}

type KimchiRegion = 'us' | 'eu' | 'self-hosted'

function regionId(value: unknown): KimchiRegion | null {
  return value === 'us' || value === 'eu' || value === 'self-hosted' ? value : null
}

function configString(config: unknown, key: string): string | undefined {
  const value = typeof config === 'object' && config !== null && key in config ? config[key] : null
  return typeof value === 'string' && value.trim() ? value : undefined
}

export async function readKimchiUsageAuth(
  options: KimchiAuthOptions = {}
): Promise<KimchiUsageAuthReadResult> {
  const env = options.env ?? process.env
  const environmentKey = env.KIMCHI_API_KEY?.trim()
  const environmentRegion = regionId(env.KIMCHI_REGION)
  let config: unknown = null
  try {
    const configPath = join(options.home ?? homedir(), '.config', 'kimchi', 'config.json')
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (
      (typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT') &&
      (!environmentKey || environmentRegion === null || environmentRegion === 'self-hosted')
    ) {
      return { status: 'error', error: 'Could not read Kimchi sign-in — run `kimchi login` again' }
    }
  }

  const configKey = configString(config, 'apiKey') ?? configString(config, 'api_key')
  const apiKey = environmentKey || configKey?.trim()
  if (!apiKey) {
    return { status: 'missing', error: 'No Kimchi sign-in on this computer — run `kimchi login`' }
  }
  const savedRegion = regionId(configString(config, 'region'))
  const region = environmentRegion ?? savedRegion ?? 'us'
  if (region === 'self-hosted') {
    return {
      status: 'unsupported',
      error: 'Kimchi usage is unavailable for self-hosted logins'
    }
  }
  const apiBaseUrl = region === 'eu' ? KIMCHI_API_BASE_URLS.eu : KIMCHI_API_BASE_URLS.us
  return {
    status: 'ok',
    auth: {
      apiKey,
      apiBaseUrl,
      credentialSource: environmentKey ? 'environment' : 'config',
      authProvenance: authFingerprint(apiKey, apiBaseUrl)
    }
  }
}
