import type { SshNativeChatRelayReadParams } from '../../shared/ssh-native-chat-relay'

/** Resolves null when the deployed relay has no native chat method, so the
 *  caller falls back to the local reader instead of failing the chat view. */
export type SshNativeChatTranscriptReader = (
  params: SshNativeChatRelayReadParams,
  options: { signal?: AbortSignal; timeoutMs?: number }
) => Promise<unknown | null>

// Why: a live SSH relay session registers itself here, exactly like
// `providers/ssh-filesystem-dispatch.ts`. Native chat must not import the SSH
// session module directly — that pulls the runtime RPC method table back into
// its own initialization and the cycle leaves `NATIVE_CHAT_METHODS` undefined.
const readers = new Map<string, SshNativeChatTranscriptReader>()

export function registerSshNativeChatTranscriptReader(
  connectionId: string,
  reader: SshNativeChatTranscriptReader
): void {
  readers.set(connectionId, reader)
}

export function unregisterSshNativeChatTranscriptReader(connectionId: string): void {
  readers.delete(connectionId)
}

export function getSshNativeChatTranscriptReader(
  connectionId: string
): SshNativeChatTranscriptReader | undefined {
  return readers.get(connectionId)
}
