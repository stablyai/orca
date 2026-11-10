import type { AgentUpdateInfo, LatestSource } from '../../shared/agent-updates/agent-update-types'
import { getMainHttpClient } from '../network/http-client'

const FETCH_TIMEOUT_MS = 8_000

type LatestRequest = { url: string; read: (response: Response) => Promise<string | null> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readJsonField(path: string): LatestRequest['read'] {
  return async (response) => {
    let value: unknown = await response.json()
    for (const key of path.split('.')) {
      value = isRecord(value) ? value[key] : undefined
    }
    return typeof value === 'string' ? value : null
  }
}

async function readText(response: Response): Promise<string | null> {
  return (await response.text()).trim() || null
}

function readTextMatch(pattern: string): LatestRequest['read'] {
  return async (response) => new RegExp(pattern, 'm').exec(await response.text())?.[1] ?? null
}

// Why: tags carry prefixes (`v1.2.3`, `rust-v0.167.0`, `@scope/pkg@2.5.2`) that the version parser rejects.
function readGithubTag(): LatestRequest['read'] {
  const readTag = readJsonField('tag_name')
  return async (response) => (await readTag(response))?.replace(/^.*?(?=\d+\.\d+\.\d+)/, '') ?? null
}

function latestRequest(source: LatestSource): LatestRequest {
  switch (source.kind) {
    case 'npm':
      return {
        url: `https://registry.npmjs.org/${source.pkg}/${source.tag ?? 'latest'}`,
        read: readJsonField('version')
      }
    case 'pypi':
      return {
        url: `https://pypi.org/pypi/${source.pkg}/json`,
        read: readJsonField('info.version')
      }
    case 'github':
      return {
        url: `https://api.github.com/repos/${source.repo}/releases/latest`,
        read: readGithubTag()
      }
    case 'json':
      return { url: source.url, read: readJsonField(source.field) }
    case 'text':
      return { url: source.url, read: readText }
    case 'text-regex':
      return { url: source.url, read: readTextMatch(source.pattern) }
  }
}

/** The agent's primary release source, then its fallback when the primary gave no version. */
export async function fetchLatestVersionWithFallback(
  info: Pick<AgentUpdateInfo, 'latest' | 'fallback'>
): Promise<string | null> {
  const primary = await fetchLatestVersion(info.latest)
  if (primary !== null || !info.fallback) {
    return primary
  }
  return fetchLatestVersion(info.fallback)
}

/** Raw version string from the agent's release source, or null on any failure. */
async function fetchLatestVersion(source: LatestSource): Promise<string | null> {
  const request = latestRequest(source)
  let response: Response
  try {
    response = await getMainHttpClient().fetch(request.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch {
    return null
  }
  if (!response.ok) {
    // Why: unread undici bodies can crash the process.
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  try {
    return await request.read(response)
  } catch {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
}
