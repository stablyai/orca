import { readHermesChatTranscriptViaWorker } from '../../../ai-vault/scanners/hermes/session-scanner-hermes-worker'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import { replacementItems } from './journal-replacement-items'

/** A Hermes conversation from the profile's state.db, the adopted transcript path; Hermes row ids
 *  are stable, so they are the journal's record ids. */
export async function prepareHermesImport(
  sessionId: string,
  options: { filePath?: string; signal?: AbortSignal },
  limits: JournalPayloadLimits
): Promise<
  { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean } | { ok: false; error: string }
> {
  if (!options.filePath) {
    return { ok: false, error: 'The conversation database is unavailable.' }
  }
  try {
    const messages = await readHermesChatTranscriptViaWorker(
      { dbPath: options.filePath, sessionId },
      options.signal
    )
    if (!messages) {
      return { ok: false, error: `No transcript found for hermes session ${sessionId}` }
    }
    const identities = messages.map((message) => ({
      provider: 'legacy' as const,
      agent: 'hermes' as const,
      sessionId,
      recordId: message.id
    }))
    return {
      ok: true,
      items: replacementItems(messages, identities, limits),
      sourceEmpty: messages.length === 0
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
