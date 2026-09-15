import { streamedSessionContentLines } from './remote-session-content-lines'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { RemoteSessionCandidate, RemoteScannerContext } from './remote-session-scanner-types'
import type { AiVaultSession } from '../../shared/ai-vault-types'

const LEGACY_SESSION_TEXT_LIMIT_BYTES = 10 * 1024 * 1024

export async function parseRemoteSessionTranscript(
  candidate: RemoteSessionCandidate,
  context: RemoteScannerContext
): Promise<AiVaultSession | null> {
  const sidecar = candidate.file.sidecar

  const exceedsWholeReadLimit =
    (candidate.file.sizeBytes ?? 0) > LEGACY_SESSION_TEXT_LIMIT_BYTES ||
    (typeof sidecar === 'object' && sidecar.sizeBytes > LEGACY_SESSION_TEXT_LIMIT_BYTES)

  if (
    exceedsWholeReadLimit &&
    candidate.source.parseDocument &&
    !candidate.file.path.endsWith('.jsonl') &&
    context.provider.readTranscriptBytes
  ) {
    return candidate.source.parseDocument(
      candidate.file,
      context.provider.readTranscriptBytes(candidate.file.path, context.signal),
      context
    )
  }

  if (
    exceedsWholeReadLimit &&
    candidate.file.path.endsWith('.jsonl') &&
    candidate.source.parseLines &&
    context.provider.readTranscriptBytes
  ) {
    return candidate.source.parseLines(
      candidate.file,
      streamedSessionContentLines(
        context.provider.readTranscriptBytes(candidate.file.path, context.signal),
        context.signal
      ),
      context
    )
  }

  const read = await context.provider.readFile(candidate.file.path)
  throwIfAiVaultScanCancelled(context.signal)

  if (read.isBinary) {
    return null
  }

  return await candidate.source.parse(candidate.file, read.content, context)
}
