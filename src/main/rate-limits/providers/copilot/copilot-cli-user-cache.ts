import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CopilotCliUserRead = {
  payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function premiumEntitlement(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) {
    return 0
  }
  const premium = payload.quota_snapshots.premium_interactions
  if (!isRecord(premium) || typeof premium.entitlement !== 'number') {
    return 0
  }
  return premium.entitlement
}

export function copilotConfigHome(): string {
  const override = process.env.COPILOT_HOME?.trim()
  return override ? override : join(homedir(), '.copilot')
}

export function copilotCacheHome(): string {
  const override = process.env.COPILOT_CACHE_HOME?.trim()
  if (override) {
    return override
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim()
    return join(local || join(homedir(), 'AppData', 'Local'), 'copilot')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'copilot')
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  return join(xdg || join(homedir(), '.cache'), 'copilot')
}

/** Picks the Copilot CLI login when present, otherwise the account that has an AIC allowance. */
export function selectCopilotCliUserPayload(cache: unknown, login: string | null): unknown | null {
  if (!isRecord(cache) || !isRecord(cache.copilotUserCache)) {
    return null
  }
  const entries = Object.values(cache.copilotUserCache).flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.response)) {
      return []
    }
    const retrievedAt = typeof entry.retrievedAt === 'string' ? Date.parse(entry.retrievedAt) : 0
    const entryLogin = typeof entry.response.login === 'string' ? entry.response.login : null
    return [{ response: entry.response, login: entryLogin, retrievedAt }]
  })
  if (login) {
    const match = entries.find((entry) => entry.login === login)
    if (match) {
      return match.response
    }
  }
  return (
    entries
      .filter((entry) => premiumEntitlement(entry.response) > 0)
      .sort((left, right) => right.retrievedAt - left.retrievedAt)[0]?.response ?? null
  )
}

export function copilotAccountFromFiles(
  config: unknown,
  cache: unknown
): { signedIn: boolean; login: string | null; planType: string | null } {
  const configLogin = loginFromConfig(config)
  const payload = selectCopilotCliUserPayload(cache, configLogin)
  const payloadLogin = isRecord(payload) && typeof payload.login === 'string' ? payload.login : null
  const login = configLogin ?? payloadLogin
  const planType =
    isRecord(payload) && typeof payload.copilot_plan === 'string' ? payload.copilot_plan : null
  return { signedIn: login !== null, login, planType }
}

function loginFromConfig(config: unknown): string | null {
  if (!isRecord(config) || !isRecord(config.lastLoggedInUser)) {
    return null
  }
  return typeof config.lastLoggedInUser.login === 'string' ? config.lastLoggedInUser.login : null
}

function parseJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) {
    return null
  }
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

/** Login and plan only. The quota fetch uses the same files and still omits tokens. */
export async function readCopilotCliAccount(): Promise<{
  signedIn: boolean
  login: string | null
  planType: string | null
}> {
  const [cacheText, configText] = await Promise.all([
    readFile(join(copilotCacheHome(), 'copilot-user-cache.json'), 'utf8').catch(() => ''),
    readFile(join(copilotConfigHome(), 'config.json'), 'utf8').catch(() => '')
  ])
  return copilotAccountFromFiles(parseJsonObject(configText), parseJsonObject(cacheText))
}

/** The CLI user cache, not `gh`, because those can be different GitHub accounts. */
export async function readCopilotCliUser(): Promise<CopilotCliUserRead | null> {
  try {
    const [cacheText, configText] = await Promise.all([
      readFile(join(copilotCacheHome(), 'copilot-user-cache.json'), 'utf8'),
      readFile(join(copilotConfigHome(), 'config.json'), 'utf8').catch(() => '')
    ])
    const payload = selectCopilotCliUserPayload(
      parseJsonObject(cacheText),
      loginFromConfig(parseJsonObject(configText))
    )
    return payload ? { payload } : null
  } catch {
    return null
  }
}
