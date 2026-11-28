import { sessionIdFromFileName } from '../../../ai-vault/parsing/session-scanner-accumulator'
import { decodeDroidTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-droid'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import { MAX_LEGACY_IMPORT_RECORD_BYTES } from './journal-legacy-transcript-stream'
import {
  prepareRecordIdTranscriptImport,
  type RecordIdImportResult
} from './journal-record-id-import'

/** A Droid session's newest history; Droid's message ids are stable, so they are the journal's
 *  record ids. An adoption also proves the file's `session_start` names the session and folder. */
export async function prepareDroidImport(
  sessionId: string,
  options: { filePath?: string; source?: AdoptedTranscriptSource; signal?: AbortSignal },
  limits: JournalPayloadLimits,
  retainedBytes: number
): Promise<RecordIdImportResult> {
  const { filePath, source } = options
  if (!filePath) {
    return { ok: false, error: `No transcript found for droid session ${sessionId}` }
  }
  if (sessionIdFromFileName(filePath) !== sessionId) {
    return {
      ok: false,
      error: 'The saved conversation does not match the requested provider identity.'
    }
  }
  const observer = source
    ? adoptedTranscriptSourceObserver({
        agent: 'droid',
        filePath,
        source,
        signal: options.signal,
        maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES
      })
    : null
  return prepareRecordIdTranscriptImport({
    agent: 'droid',
    sessionId,
    filePath,
    decode: decodeDroidTranscriptLine,
    ...(observer ? { observe: observer.observe, validate: observer.validate } : {}),
    signal: options.signal,
    limits,
    retainedBytes
  })
}
