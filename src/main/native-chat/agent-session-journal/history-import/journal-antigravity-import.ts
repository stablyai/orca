import { antigravityConversationIdFromTranscriptPath } from '../../../ai-vault/scanners/antigravity/session-scanner-antigravity-paths'
import { decodeAntigravityTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-antigravity'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { createNewestItemWindow } from './journal-newest-item-window'
import { replacementItem } from './journal-replacement-items'

/** An agy conversation's newest words from its transcript; agy step indexes are stable, so they
 *  are the journal's record ids. The transcript lives under the conversation's own folder, so
 *  that folder must name the conversation being adopted. */
export async function prepareAntigravityImport(
  sessionId: string,
  options: { filePath?: string; signal?: AbortSignal },
  limits: JournalPayloadLimits,
  retainedBytes: number
): Promise<
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean }
  | { ok: false; error: string; cause?: unknown }
> {
  if (!options.filePath) {
    return { ok: false, error: `No transcript found for antigravity session ${sessionId}` }
  }
  if (antigravityConversationIdFromTranscriptPath(options.filePath) !== sessionId) {
    return {
      ok: false,
      error: 'The saved conversation does not match the requested provider identity.'
    }
  }
  try {
    const retained = createNewestItemWindow(retainedBytes)
    let decoded = 0
    const { consumedBytes } = await readLegacyImportTranscript(
      { filePath: options.filePath, codex: false },
      (line) => {
        options.signal?.throwIfAborted()
        const step = decodeAntigravityTranscriptLine(line)
        if (step) {
          decoded++
          retained.push(
            replacementItem(
              step.message,
              { provider: 'legacy', agent: 'antigravity', sessionId, recordId: step.recordId },
              limits
            )
          )
        }
        return null
      }
    )
    return { ok: true, items: retained.items(), sourceEmpty: consumedBytes === 0 || decoded === 0 }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error
    }
  }
}
