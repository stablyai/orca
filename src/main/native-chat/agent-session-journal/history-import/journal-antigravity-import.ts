import { antigravityConversationIdFromTranscriptPath } from '../../../ai-vault/scanners/antigravity/session-scanner-antigravity-paths'
import { decodeAntigravityTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-antigravity'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  prepareRecordIdTranscriptImport,
  type RecordIdImportResult
} from './journal-record-id-import'

/** An agy conversation's newest words from its transcript; agy step indexes are stable, so they
 *  are the journal's record ids. The transcript lives under the conversation's own folder, so
 *  that folder must name the conversation being adopted. */
export async function prepareAntigravityImport(
  sessionId: string,
  options: { filePath?: string; signal?: AbortSignal },
  limits: JournalPayloadLimits,
  retainedBytes: number
): Promise<RecordIdImportResult> {
  if (!options.filePath) {
    return { ok: false, error: `No transcript found for antigravity session ${sessionId}` }
  }
  if (antigravityConversationIdFromTranscriptPath(options.filePath) !== sessionId) {
    return {
      ok: false,
      error: 'The saved conversation does not match the requested provider identity.'
    }
  }
  return prepareRecordIdTranscriptImport({
    agent: 'antigravity',
    sessionId,
    filePath: options.filePath,
    decode: decodeAntigravityTranscriptLine,
    signal: options.signal,
    limits,
    retainedBytes
  })
}
