import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

// Why rows, from each dialog's first `·` on: codex.json's provisional_startup takes a `·` after the
// startup header for the live chat's footer, so each dialog must be matched by the time that `·`
// lands. Why not headings: Codex 0.157+ paints them by cell diff over its startup screen, so the
// text copy can lose letters and spaces (`updat available`); these rows are fixed literals.
// Update: `Update available · 0.157.1 → 0.158.0`, then `enter continue · esc skip`.
const CODEX_UPDATE_ROW_RE = /available\s*·\s*\d+\.\d+|enter\s*continue\s*·\s*esc\s*skip/g
// Why not `esc back`: Codex's mid-session pickers end `enter confirm · esc back`.
const CODEX_HOOKS_REVIEW_KEY_ROW_RE = /enter\s*confirm\s*·(?!\s*esc\s*back)/g
// Why both verbs: the retired-model notice says `continue`, the new-model announcement `confirm`.
const CODEX_MODEL_MIGRATION_KEY_ROW_RE = /enter\/esc\s*(?:continue|confirm)\s*·/g

function lastMatchIndex(text: string, row: RegExp): number {
  let index = -1
  for (const match of text.matchAll(row)) {
    index = match.index
  }
  return index
}

// Why the last match, and the legacy wording too: an answered dialog stays in the text copy, and
// builds before 0.157 wrote `Press enter to continue/confirm`.
function findDialogIndex(
  normalized: string,
  legacyHeading: string,
  legacyKeys: string,
  row: RegExp
): number {
  const rowIndex = lastMatchIndex(normalized, row)
  const headingIndex = normalized.lastIndexOf(legacyHeading)
  const legacyIndex =
    headingIndex !== -1 && normalized.includes(legacyKeys, headingIndex) ? headingIndex : -1
  return Math.max(rowIndex, legacyIndex)
}

// Why together: each startup dialog owns Enter before the chat exists, so a brief typed into one
// answers it (Codex's update dialog defaults to `Update now`).
export function findStartupDialogBlockedSignals(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number }[] {
  const candidates: { reason: RuntimeTerminalWaitBlockedReason; index: number }[] = []
  const updateIndex = findDialogIndex(
    normalized,
    'update available',
    'press enter to continue',
    CODEX_UPDATE_ROW_RE
  )
  if (updateIndex !== -1) {
    candidates.push({ reason: 'agent-update-prompt', index: updateIndex })
  }
  const cwdIndex = normalized.lastIndexOf('choose working directory to')
  if (cwdIndex !== -1 && normalized.includes('press enter to continue', cwdIndex)) {
    candidates.push({ reason: 'agent-cwd-prompt', index: cwdIndex })
  }
  const modelMigrationIndex = findDialogIndex(
    normalized,
    'codex just got an upgrade',
    'press enter to continue',
    CODEX_MODEL_MIGRATION_KEY_ROW_RE
  )
  if (modelMigrationIndex !== -1) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelMigrationIndex })
  }
  const hooksIndex = findDialogIndex(
    normalized,
    'hooks need review',
    'press enter to confirm',
    CODEX_HOOKS_REVIEW_KEY_ROW_RE
  )
  if (hooksIndex !== -1) {
    // Why neutral: this matcher never inspects the agent -- 'hooks need review' is not Codex-only wording.
    candidates.push({ reason: 'agent-hooks-review-prompt', index: hooksIndex })
  }
  return candidates
}
