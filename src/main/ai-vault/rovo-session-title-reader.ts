import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'

// Rovo session ids are UUIDs; anything path-like must never be joined into a sessions root.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

/** Reads Rovo's own session title (AI-generated, or the user's /rename) by session id. */
export async function readRovoSessionTitle(
  sessionId: string,
  options: { roots?: string[]; signal?: AbortSignal } = {}
): Promise<string | null> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return null
  }
  // Same roots the vault scans: ~/.rovo first, then the legacy ~/.rovodev copy.
  for (const root of options.roots ?? AI_VAULT_AGENT_SOURCES.rovo.rootDirs({}, [])) {
    if (options.signal?.aborted) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(root, sessionId, 'metadata.json'), 'utf8')
      )
      const title =
        typeof parsed === 'object' && parsed !== null && 'title' in parsed
          ? parsed.title
          : undefined
      if (typeof title === 'string' && title.trim()) {
        return title.trim()
      }
    } catch {
      // Missing or mid-write metadata: try the next root, then report no title.
    }
  }
  return null
}
