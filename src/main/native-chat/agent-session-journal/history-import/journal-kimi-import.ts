import { basename } from 'node:path'
import { kimiSessionDirFromWirePath } from '../../../ai-vault/scanners/kimi/session-scanner-kimi-paths'
import { createKimiActiveBranch } from '../../../kimi/kimi-wire-active-branch'
import { decodeKimiWireLine } from '../../transcript-decoding/transcript-line-decoders-kimi'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
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
  // Turns undone with `/undo` stay in the file on an abandoned branch, so the branches are read
  // first and the bounded import then takes only the conversation's own records.
  const branch = createKimiActiveBranch()
  try {
    await readLegacyImportTranscript({ filePath: options.filePath, codex: false }, (line) => {
      options.signal?.throwIfAborted()
      branch.number(line)
      return null
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error
    }
  }
  const onChain = branch.onActiveChain()
  let lineNumber = 0
  return prepareRecordIdTranscriptImport({
    agent: 'kimi',
    sessionId,
    filePath: options.filePath,
    decode: (line) => (onChain(++lineNumber) ? decodeKimiWireLine(line) : null),
    signal: options.signal,
    limits,
    retainedBytes
  })
}
