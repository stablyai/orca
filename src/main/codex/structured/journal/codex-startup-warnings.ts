import { BoundedMap } from '../../../../shared/collections/bounded-map'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import {
  MAX_CODEX_STARTUP_WARNING_BYTES,
  MAX_CODEX_STARTUP_WARNING_ENTRIES
} from './codex-structured-journal-limits'

/** Codex reports each startup config warning to the connection and again to the new thread. */
const PAIRED_KINDS = new Set(['notification:configWarning', 'notification:warning'])

/** Draws one row for a pre-turn warning that both a configWarning and a warning frame report. */
export class CodexStartupWarnings {
  /** Thread and text of each unpaired pre-turn warning row, mapped to the kind that drew it. */
  private readonly unpaired = new BoundedMap<string, string>({
    maxEntries: MAX_CODEX_STARTUP_WARNING_ENTRIES,
    maxBytes: MAX_CODEX_STARTUP_WARNING_BYTES,
    sizeOf: (_kind, key) => key.length * 2
  })

  append(
    kind: string,
    threadId: string,
    text: string,
    appendRow: () => CodexJournalTranslationAdmission
  ): CodexJournalTranslationAdmission {
    if (!PAIRED_KINDS.has(kind)) {
      return appendRow()
    }
    // configWarning keeps the raw summary while warning rows are trimmed.
    const key = `${threadId}\0${text.trim()}`
    const drawnBy = this.unpaired.peek(key)
    if (drawnBy !== undefined && drawnBy !== kind) {
      this.unpaired.delete(key)
      return CODEX_JOURNAL_ADMITTED
    }
    const admission = appendRow()
    if (admission.accepted) {
      this.unpaired.set(key, kind)
    }
    return admission
  }

  clear(): void {
    this.unpaired.clear()
  }
}
