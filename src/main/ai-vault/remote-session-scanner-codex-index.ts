import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type {
  RemoteScannerContext,
  RemoteSessionFilesystemProvider
} from './remote-session-scanner-types'

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

// One index read per CODEX_HOME per scan (`context.titleCaches` is scan-scoped);
// used both by the transcript parse and by the parse cache's reuse path.
export function remoteCodexIndexedTitleReader(
  codexHome: string,
  context: RemoteScannerContext
): (sessionId: string) => Promise<string | null> {
  return async (sessionId) =>
    (
      await remoteCodexIndexTitles({
        provider: context.provider,
        codexHome,
        hostPlatform: context.hostPlatform,
        titleCaches: context.titleCaches,
        signal: context.signal
      })
    ).get(sessionId) ?? null
}

export async function remoteCodexIndexTitles(args: {
  provider: RemoteSessionFilesystemProvider
  codexHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
  signal?: AbortSignal
}): Promise<Map<string, string>> {
  const cached = args.titleCaches.get(args.codexHome)
  if (cached) {
    return cached
  }
  const pending = readRemoteCodexIndexTitles(
    args.provider,
    args.codexHome,
    args.hostPlatform,
    args.signal
  )
  args.titleCaches.set(args.codexHome, pending)
  return pending
}

async function readRemoteCodexIndexTitles(
  provider: RemoteSessionFilesystemProvider,
  codexHome: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    throwIfAiVaultScanCancelled(signal)
    const { content, isBinary } = await provider.readFile(
      joinRemotePath(hostPlatform, codexHome, CODEX_SESSION_INDEX_FILE)
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
    // Codex indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
