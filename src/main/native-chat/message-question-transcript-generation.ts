import { randomUUID } from 'node:crypto'
import {
  boundaryFingerprint,
  readTranscriptFileVersion,
  transcriptFileVersionChanged
} from './transcript-file-version'
import type { MessageQuestionSourceState } from './message-question-source'

/** Replacement evidence survives watcher disposal; the saved offset is not an ingestion checkpoint. */
export async function messageQuestionTranscriptGeneration(
  filePath: string,
  saved: MessageQuestionSourceState | null,
  signal?: AbortSignal
) {
  const version = await readTranscriptFileVersion(filePath, signal)
  const previous = saved?.file
  const replaced = Boolean(
    previous &&
    (version.identity !== previous.identity ||
      version.size < previous.offset ||
      (version.size === previous.size && transcriptFileVersionChanged(version, previous)) ||
      (await boundaryFingerprint(filePath, previous.offset, signal)) !== previous.boundary)
  )
  return { version, replaced, generation: !saved || replaced ? randomUUID() : saved.generation }
}

export function isPositionalMessageQuestionRow(filePath: string, sourceRowId: string): boolean {
  const prefix = `${filePath}:`
  return sourceRowId.startsWith(prefix) && /^\d{16}$/.test(sourceRowId.slice(prefix.length))
}
