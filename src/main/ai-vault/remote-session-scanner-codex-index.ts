import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

export async function remoteCodexIndexTitles(args: {
  provider: IFilesystemProvider
  codexHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
}): Promise<Map<string, string>> {
  const cached = args.titleCaches.get(args.codexHome)
  if (cached) {
    return cached
  }
  const pending = readRemoteCodexIndexTitles(args.provider, args.codexHome, args.hostPlatform)
  args.titleCaches.set(args.codexHome, pending)
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
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch {
    // Codex indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
