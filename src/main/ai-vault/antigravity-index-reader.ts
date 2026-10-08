import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  readBoundedAntigravityIndex
} from './session-scanner-antigravity-metadata'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'
import {
  abandonRemoteSessionScanOnCancel,
  throwIfAiVaultScanCancelled
} from './ai-vault-scan-cancellation'

export async function readRemoteAntigravityIndex(
  provider: RemoteSessionFilesystemProvider,
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(signal)
    if (provider.readTranscriptBytes) {
      return await abandonRemoteSessionScanOnCancel(
        readBoundedAntigravityIndex(
          provider.readTranscriptBytes(path, signal, {
            regularFileOnly: true,
            maxBytes: ANTIGRAVITY_INDEX_MAX_BYTES
          })
        ),
        signal
      )
    }
    const stat = await abandonRemoteSessionScanOnCancel(provider.stat(path), signal)
    if (stat.type !== 'file' || stat.size > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return null
    }
    const read = await abandonRemoteSessionScanOnCancel(
      provider.readFile(path, { maxTextBytes: ANTIGRAVITY_INDEX_MAX_BYTES }),
      signal
    )
    throwIfAiVaultScanCancelled(signal)
    return read.isBinary || Buffer.byteLength(read.content) > ANTIGRAVITY_INDEX_MAX_BYTES
      ? null
      : read.content
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    return null
  }
}
