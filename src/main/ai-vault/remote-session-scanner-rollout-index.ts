import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'

const SESSION_INDEX_FILE = 'session_index.jsonl'

export async function remoteRolloutIndexTitles(args: {
  provider: RemoteSessionFilesystemProvider
  sessionHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
  signal?: AbortSignal
}): Promise<Map<string, string>> {
  const cached = args.titleCaches.get(args.sessionHome)
  if (cached) {
    return cached
  }
  const pending = readRemoteRolloutIndexTitles(
    args.provider,
    args.sessionHome,
    args.hostPlatform,
    args.signal
  )
  args.titleCaches.set(args.sessionHome, pending)
  return pending
}

async function readRemoteRolloutIndexTitles(
  provider: RemoteSessionFilesystemProvider,
  sessionHome: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    throwIfAiVaultScanCancelled(signal)
    const { content, isBinary } = await provider.readFile(
      joinRemotePath(hostPlatform, sessionHome, SESSION_INDEX_FILE)
    )
    throwIfAiVaultScanCancelled(signal)
    if (isBinary) {
      return titleBySessionId
    }
    for await (const line of remoteSessionContentLines(content, signal)) {
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
    throwIfAiVaultScanCancelled(signal)
    // Session indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
