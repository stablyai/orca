import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'
import {
  CODEX_SESSION_INDEX_CACHE_KEY_MAX_UTF8_BYTES,
  CODEX_SESSION_INDEX_TITLE_CACHE_MAX,
  retainCodexSessionIndexTitle
} from './session-scanner-codex-title-index'

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

export async function remoteCodexIndexTitles(args: {
  provider: IFilesystemProvider
  codexHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
}): Promise<Map<string, string>> {
  const cacheable =
    Buffer.byteLength(args.codexHome, 'utf8') <= CODEX_SESSION_INDEX_CACHE_KEY_MAX_UTF8_BYTES
  const cached = cacheable ? args.titleCaches.get(args.codexHome) : undefined
  if (cached) {
    args.titleCaches.delete(args.codexHome)
    args.titleCaches.set(args.codexHome, cached)
    return cached
  }
  const pending = readRemoteCodexIndexTitles(args.provider, args.codexHome, args.hostPlatform)
  if (cacheable) {
    args.titleCaches.set(args.codexHome, pending)
    while (args.titleCaches.size > CODEX_SESSION_INDEX_TITLE_CACHE_MAX) {
      const oldest = args.titleCaches.keys().next().value
      if (oldest === undefined) {
        break
      }
      args.titleCaches.delete(oldest)
    }
  }
  return pending
}

async function readRemoteCodexIndexTitles(
  provider: IFilesystemProvider,
  codexHome: string,
  hostPlatform: RemoteHostPlatform
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    const { content, isBinary } = await provider.readFile(
      joinRemotePath(hostPlatform, codexHome, CODEX_SESSION_INDEX_FILE)
    )
    if (isBinary) {
      return titleBySessionId
    }
    for (const line of content.split(/\r?\n/)) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        retainCodexSessionIndexTitle(titleBySessionId, sessionId, title)
      }
    }
  } catch {
    // Codex indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
