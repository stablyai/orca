import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { createNewestItemWindow } from './journal-newest-item-window'
import { replacementItem } from './journal-replacement-items'

export type RecordIdImportResult =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean }
  | { ok: false; error: string; cause?: unknown }

/** A transcript's newest words, for an agent whose records carry stable ids: those ids are the
 *  journal's record ids. `observe` sees lines until it returns true; `validate` runs after them,
 *  and `keep`, once every line is read, drops records the transcript later abandoned. */
export async function prepareRecordIdTranscriptImport(input: {
  agent: 'antigravity' | 'droid' | 'kimi'
  sessionId: string
  filePath: string
  decode: (line: string) => { recordId: string; message: NativeChatMessage } | null
  observe?: (line: string) => boolean
  validate?: () => Promise<void>
  keep?: () => (recordId: string) => boolean
  signal?: AbortSignal
  limits: JournalPayloadLimits
  retainedBytes: number
}): Promise<RecordIdImportResult> {
  try {
    const retained = createNewestItemWindow(input.retainedBytes)
    let decoded = 0
    let observed = !input.observe
    const { consumedBytes } = await readLegacyImportTranscript(
      { filePath: input.filePath, codex: false },
      (line) => {
        input.signal?.throwIfAborted()
        observed ||= input.observe?.(line) ?? true
        const record = input.decode(line)
        if (record) {
          decoded++
          retained.push(
            replacementItem(
              record.message,
              {
                provider: 'legacy',
                agent: input.agent,
                sessionId: input.sessionId,
                recordId: record.recordId
              },
              input.limits
            )
          )
        }
        return null
      }
    )
    await input.validate?.()
    const keep = input.keep?.()
    const items = keep
      ? retained
          .items()
          .filter((item) => item.identity.provider !== 'legacy' || keep(item.identity.recordId))
      : retained.items()
    return { ok: true, items, sourceEmpty: consumedBytes === 0 || decoded === 0 }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error
    }
  }
}
