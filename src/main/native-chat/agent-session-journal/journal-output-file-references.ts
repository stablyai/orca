import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'

export const JOURNAL_OUTPUT_FILE_DIRECTORY = 'agent-session-outputs'

/** A completed output or patch kept beside the journal; `head` is its start, `outputFile` its sha256. */
export type JournalFileBackedPayload = AgentJournalBoundedPayload & { outputFile: string }

export function journalOutputFilePath(stateDirectory: string, digest: string): string {
  return join(stateDirectory, JOURNAL_OUTPUT_FILE_DIRECTORY, digest.slice(0, 2), `${digest}.txt`)
}

export function journalOutputFile(payload: AgentJournalBoundedPayload | undefined): string | null {
  const file: unknown = payload && 'outputFile' in payload ? payload.outputFile : undefined
  return typeof file === 'string' && /^[0-9a-f]{64}$/.test(file) ? file : null
}

/** A saved body whose output moved to its file still equals the whole output it was cut from. */
export function sameJournalItemBody(
  saved: AgentJournalItemBody,
  next: AgentJournalItemBody
): boolean {
  return isDeepStrictEqual(saved, withSavedOutputFile(saved, next))
}

function withSavedOutputFile(
  saved: AgentJournalItemBody,
  next: AgentJournalItemBody
): AgentJournalItemBody {
  const matches = (
    kept: AgentJournalBoundedPayload | undefined,
    whole: AgentJournalBoundedPayload | undefined
  ) =>
    kept !== undefined &&
    whole !== undefined &&
    journalOutputFile(kept) !== null &&
    !whole.truncated &&
    whole.digest === kept.digest &&
    whole.byteLength === kept.byteLength
  if (
    saved.kind === 'tool-call' &&
    next.kind === 'tool-call' &&
    matches(saved.output, next.output)
  ) {
    return { ...next, output: saved.output }
  }
  if (saved.kind === 'diff' && next.kind === 'diff' && matches(saved.patch, next.patch)) {
    return { ...next, patch: saved.patch }
  }
  return next
}
