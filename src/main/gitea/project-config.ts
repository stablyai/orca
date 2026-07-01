import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeGiteaApiBaseUrl } from './client'

export type GiteaProjectConfig = {
  token?: string
  apiBaseUrl?: string
}

export type GiteaAuthConfig = {
  apiBaseUrl: string | null
  token: string | null
}

const CONFIG_FILE_NAME = 'gitea.json'
const CONFIG_DIR = '.orca'
const MISS_CACHE_TTL_MS = 30_000

type CacheEntry = {
  value: GiteaProjectConfig | null
  expiresAt: number | null
}

const configCache = new Map<string, CacheEntry>()

/** @internal - exposed for tests only */
export function _resetProjectConfigCache(): void {
  configCache.clear()
}

export async function readProjectGiteaConfig(repoPath: string): Promise<GiteaProjectConfig | null> {
  const cached = configCache.get(repoPath)
  if (cached) {
    if (cached.expiresAt === null || Date.now() < cached.expiresAt) {
      return cached.value
    }
    configCache.delete(repoPath)
  }

  try {
    const configPath = join(repoPath, CONFIG_DIR, CONFIG_FILE_NAME)
    const content = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    const config: GiteaProjectConfig = {}
    if (typeof parsed.token === 'string' && parsed.token.trim().length > 0) {
      config.token = parsed.token.trim()
    }
    if (typeof parsed.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim().length > 0) {
      config.apiBaseUrl = parsed.apiBaseUrl.trim()
    }
    const result = config.token || config.apiBaseUrl ? config : null
    configCache.set(repoPath, { value: result, expiresAt: null })
    return result
  } catch {
    configCache.set(repoPath, { value: null, expiresAt: Date.now() + MISS_CACHE_TTL_MS })
    return null
  }
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function getEnvGiteaAuth(): GiteaAuthConfig {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

export async function resolveGiteaAuth(repoPath?: string): Promise<GiteaAuthConfig> {
  const envAuth = getEnvGiteaAuth()

  if (!repoPath) {
    return envAuth
  }

  const projectConfig = await readProjectGiteaConfig(repoPath)
  if (!projectConfig) {
    return envAuth
  }

  // Why: when the project overrides apiBaseUrl, do NOT fall back to the global
  // env token — a malicious repo could set apiBaseUrl to exfiltrate the user's
  // global token. Only combine project apiBaseUrl with a project-supplied token.
  if (projectConfig.apiBaseUrl) {
    return {
      apiBaseUrl: normalizeGiteaApiBaseUrl(projectConfig.apiBaseUrl),
      token: projectConfig.token ?? null
    }
  }

  return {
    apiBaseUrl: envAuth.apiBaseUrl,
    token: projectConfig.token ?? envAuth.token
  }
}
