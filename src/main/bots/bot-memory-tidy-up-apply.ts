// Writes a tidy-up's draft: checked against the MEMORY.md the run read, then written onto the
// files as they are now, memory/ first, so a line MEMORY.md loses is always kept somewhere.
import type { BotMemoryChange } from '../../shared/bot-memory-lines'
import type { BotHomeFilesystem } from './bot-home'
import type { BotMemoryRecord } from './bot-memory-record'
import { TIDY_UP_FAILURES, type TidyUpApplied } from './bot-memory-tidy-up'
import {
  checkTidyUpDraft,
  tidyUpChangeFor,
  tidyUpDraft,
  TidyUpRefused,
  tidyUpSummaryOf,
  writeTidyUpFiles
} from './bot-memory-tidy-up-draft'

export async function applyTidyUpDraft(
  deps: {
    memory: Pick<BotMemoryRecord, 'change'>
    fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>
  },
  run: { botId: string; folder: string; memory: string; reply: string; today: string }
): Promise<{ error: string; alerted: false } | TidyUpApplied> {
  const { botId, folder, today } = run
  const draft = tidyUpDraft(run.reply)
  const checked = draft
    ? checkTidyUpDraft(run.memory, draft)
    : { refused: TIDY_UP_FAILURES.noDraft }
  if ('refused' in checked) {
    return { error: checked.refused, alerted: false }
  }
  const { plan } = checked
  let asked: BotMemoryChange = { added: [], removed: [] }
  const written = new Map<string, number>()
  try {
    const made = await deps.memory.change(
      botId,
      folder,
      { kind: 'tidy-up' },
      (file) => (asked = tidyUpChangeFor(plan, file)),
      (willMake) => writeTidyUpFiles(deps.fs, folder, plan, willMake, today, written)
    )
    return tidyUpSummaryOf(plan, asked, made, written)
  } catch (error) {
    if (error instanceof TidyUpRefused) {
      return { error: error.message, alerted: false }
    }
    console.warn('[bots] tidy-up could not apply', error)
    return { error: TIDY_UP_FAILURES.notApplied, alerted: false }
  }
}
