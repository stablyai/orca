import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

// Match rows by their first ·, before provisional startup mistakes it for a chat footer.
// Codex 0.157+ cell-diff painting corrupts heading text; fixed key/update rows survive.
const CODEX_UPDATE_ROW_RE = /available\s*\u00B7\s*\d+\.\d+|enter\s*continue\s*\u00B7\s*esc\s*skip/g
// Why not `esc back`: Codex's mid-session pickers end `enter confirm · esc back`.
const CODEX_HOOKS_REVIEW_KEY_ROW_RE = /enter\s*confirm\s*\u00B7(?!\s*esc\s*back)/g
// Why both verbs: the retired-model notice says `continue`, the new-model announcement `confirm`.
const CODEX_MODEL_MIGRATION_KEY_ROW_RE = /enter\/esc\s*(?:continue|confirm)\s*\u00B7/g
// Claude 2.1.316 menus shown before its first prompt; mid-session pickers share the key row, not these headings.
const CLAUDE_STARTUP_MENU_HEADING_RE =
  /new\s*mcp\s*servers?\s*found|detected\s*a\s*custom\s*api\s*key|running\s*in\s*bypass\s*permissions\s*mode|allow\s*external\s*claude\.md\s*file\s*imports/g
const CLAUDE_STARTUP_MENU_KEY_ROW_RE = /enter\s*to\s*confirm\s*\u00B7\s*esc\s*to\s*cancel/

function lastMatchIndex(text: string, row: RegExp): number {
  let index = -1
  for (const match of text.matchAll(row)) {
    index = match.index
  }
  return index
}

// Use the last match because answered dialogs persist in text; include pre-0.157 Press enter wording.
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

// Startup dialogs own Enter before chat exists; submitting a brief could accept Update now instead.
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
    // Hooks-review wording is agent-neutral; this matcher never establishes agent identity.
    candidates.push({ reason: 'agent-hooks-review-prompt', index: hooksIndex })
  }
  const claudeMenuIndex = lastMatchIndex(normalized, CLAUDE_STARTUP_MENU_HEADING_RE)
  if (
    claudeMenuIndex !== -1 &&
    CLAUDE_STARTUP_MENU_KEY_ROW_RE.test(normalized.slice(claudeMenuIndex))
  ) {
    candidates.push({ reason: 'agent-startup-menu-prompt', index: claudeMenuIndex })
  }
  return candidates
}
