import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../codex/config-toml-line-scan'

const DEFAULT_CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api'
const OFFICIAL_CHATGPT_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com',
  'www.chat.openai.com'
])

function isOfficialChatGptHost(hostname: string): boolean {
  return OFFICIAL_CHATGPT_HOSTS.has(hostname.toLowerCase())
}

function hasBackendApiSuffix(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return normalized === '/backend-api' || normalized.endsWith('/backend-api')
}

// Why: official ChatGPT backends expose WHAM below /backend-api, while custom
// Codex backends retain their configured path and use /api/codex routes.
export function normalizeCodexBackendBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw?.trim() || DEFAULT_CHATGPT_BACKEND_BASE_URL).replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/\/+$/, '')
    if (isOfficialChatGptHost(url.hostname) && !hasBackendApiSuffix(url.pathname)) {
      return `${url.origin}${path === '' || path === '/' ? '' : path}/backend-api`
    }
    return `${url.origin}${path === '/' ? '' : path}` || url.origin
  } catch {
    return trimmed
  }
}

function isOfficialChatGptBackend(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return isOfficialChatGptHost(url.hostname) && hasBackendApiSuffix(url.pathname)
  } catch {
    return false
  }
}

export function buildCodexRateLimitResetCreditsUrl(baseUrl: string): string {
  const normalized = normalizeCodexBackendBaseUrl(baseUrl)
  return isOfficialChatGptBackend(normalized)
    ? `${normalized}/wham/rate-limit-reset-credits`
    : `${normalized}/api/codex/rate-limit-reset-credits`
}

export function buildCodexRateLimitResetCreditsConsumeUrl(baseUrl: string): string {
  return `${buildCodexRateLimitResetCreditsUrl(baseUrl)}/consume`
}

function parseTopLevelTomlString(config: string, key: string): string | null {
  const content = config.charCodeAt(0) === 0xfeff ? config.slice(1) : config
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyPattern = new RegExp(
    `^[ \\t]*(?:"${escapedKey}"|'${escapedKey}'|${escapedKey})[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)')`
  )
  let scanState = createTomlLineScanState()
  for (const line of content.split('\n')) {
    if (isTomlStructuralLine(scanState)) {
      if (getTomlTableHeader(line)) {
        break
      }
      const match = keyPattern.exec(line)
      if (match) {
        return match[1] ?? match[2] ?? null
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return null
}

export async function resolveCodexBackendBaseUrl(
  codexHomePath: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const config = await readFile(
      join(codexHomePath, 'config.toml'),
      signal ? { encoding: 'utf8', signal } : 'utf8'
    )
    return normalizeCodexBackendBaseUrl(parseTopLevelTomlString(config, 'chatgpt_base_url'))
  } catch {
    return DEFAULT_CHATGPT_BACKEND_BASE_URL
  }
}
