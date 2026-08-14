// Why: direct service API calls (session lookup, interrupt) share auth and
// cancel-body discipline.

import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { buildOpenCode2AuthHeaders, type OpenCode2ServiceInfo } from './service-discovery'

export type OpenCode2SessionDirectoryResult = { ok: true; directory: string } | { ok: false }

/** GET /api/session/{id} and extract the session's working directory. */
export async function fetchOpenCode2SessionDirectory(
  info: OpenCode2ServiceInfo,
  sessionId: string
): Promise<OpenCode2SessionDirectoryResult> {
  try {
    const response = await fetch(`${info.url}/api/session/${encodeURIComponent(sessionId)}`, {
      headers: { ...buildOpenCode2AuthHeaders(info) },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) {
      // Why: an unread undici body can crash the process (orca#8695).
      await cancelUnreadResponseBody(response)
      return { ok: false }
    }
    const body = (await response.json()) as {
      data?: { location?: { directory?: unknown } }
    }
    const directory = body.data?.location?.directory
    return typeof directory === 'string' && directory.trim().length > 0
      ? { ok: true, directory: directory.trim() }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** POST /api/session/{id}/interrupt — best-effort; the TUI's own Escape handling is the fallback. */
export async function postOpenCode2SessionInterrupt(
  info: OpenCode2ServiceInfo,
  sessionId: string
): Promise<void> {
  try {
    const response = await fetch(
      `${info.url}/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: 'POST',
        headers: { ...buildOpenCode2AuthHeaders(info) },
        signal: AbortSignal.timeout(5000)
      }
    )
    await cancelUnreadResponseBody(response)
  } catch {
    // best-effort; the TUI's own Escape handling is the fallback
  }
}
