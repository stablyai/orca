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
  const { version, replaced } = await qualifyMessageQuestionTranscript(
    filePath,
    saved?.file ? [saved.file] : [],
    signal
  )
  return { version, replaced, generation: !saved || replaced ? randomUUID() : saved.generation }
}

/** The selected replacement evidence, bracketed across every awaited boundary probe. */
export async function qualifyMessageQuestionTranscript(
  filePath: string,
  frontiers: readonly NonNullable<MessageQuestionSourceState['file']>[],
  signal?: AbortSignal
) {
  const opening = await readTranscriptFileVersion(filePath, signal)
  const incompatible = (current: typeof opening, previous: typeof opening, offset: number) =>
    current.identity !== previous.identity ||
    current.size < offset ||
    (current.size === previous.size && transcriptFileVersionChanged(current, previous))
  let replaced = frontiers.some((frontier) => incompatible(opening, frontier, frontier.offset))
  const samples = new Map<number, string>()
  for (const frontier of frontiers) {
    let boundary = samples.get(frontier.offset)
    if (boundary === undefined) {
      boundary = await boundaryFingerprint(filePath, frontier.offset, signal)
      samples.set(frontier.offset, boundary)
    }
    if (boundary !== frontier.boundary) {
      replaced = true
    }
  }
  const version = await readTranscriptFileVersion(filePath, signal)
  replaced ||=
    incompatible(version, opening, Math.max(0, ...frontiers.map((f) => f.offset))) ||
    frontiers.some((frontier) => incompatible(version, frontier, frontier.offset))
  return { version, replaced }
}

export function isPositionalMessageQuestionRow(filePath: string, sourceRowId: string): boolean {
  const prefix = `${filePath}:`
  return sourceRowId.startsWith(prefix) && /^\d{16}$/.test(sourceRowId.slice(prefix.length))
}
