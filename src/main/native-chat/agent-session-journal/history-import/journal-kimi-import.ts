import { basename } from 'node:path'
import { kimiSessionDirFromWirePath } from '../../../ai-vault/scanners/kimi/session-scanner-kimi-paths'
import { decodeKimiWireLine } from '../../transcript-decoding/transcript-line-decoders-kimi'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  prepareRecordIdTranscriptImport,
  type RecordIdImportResult
} from './journal-record-id-import'

/** A Kimi session's newest words from its wire transcript; Kimi's message and block ids are
 *  stable, so they are the journal's record ids. The transcript sits in the session's own folder,
 *  so that folder must name the session being adopted. */
export async function prepareKimiImport(
  sessionId: string,
  options: { filePath?: string; signal?: AbortSignal },
  limits: JournalPayloadLimits,
  retainedBytes: number
): Promise<RecordIdImportResult> {
  if (!options.filePath) {
    return { ok: false, error: `No transcript found for kimi session ${sessionId}` }
  }
  if (basename(kimiSessionDirFromWirePath(options.filePath)) !== sessionId) {
    return {
      ok: false,
      error: 'The saved conversation does not match the requested provider identity.'
    }
  }
  return prepareRecordIdTranscriptImport({
    agent: 'kimi',
    sessionId,
    filePath: options.filePath,
    decode: decodeKimiWireLine,
    signal: options.signal,
    limits,
    retainedBytes
  })
}
