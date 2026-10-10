import type { SessionAccumulator } from './session-scanner-types'
import {
  asRecord,
  extractGitBranch,
  extractString,
  normalizeTitleText
} from './session-scanner-values'
import {
  readCodexNonUserOrigin,
  type CodexNonUserOrigin
} from './session-scanner-codex-non-user-origin'

// Codex's `session_meta` record, whose key spelling has drifted across Codex
// releases (snake_case rollouts, camelCase app-server rollouts).
// Whether the thread is the user's own is read by `session-scanner-codex-non-user-origin.ts`.

/** The parse state a rollout's `session_meta` records decide. */
export type CodexSessionMetaState = {
  accumulator: SessionAccumulator
  // Codex's own classification of this thread as something other than the
  // user's own — a spawned agent, a review pass, a compaction, a guardian. Codex
  // writes all of those into the same history tree and AI Vault shows
  // user-started sessions only, so the parse is rejected on this record's
  // presence rather than on a separate flag beside it.
  nonUserOrigin: CodexNonUserOrigin | null
  sawSessionMeta: boolean
  historyMode: string | null
  // Which source set the current title; an index-file title outranks the raw
  // first user prompt, so finalize must know whether 'meta' already won.
  titleSource: 'meta' | 'user' | null
}

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}

/**
 * The first `session_meta` is the thread's own and owns its identity and classification. Codex
 * re-appends that record, same id, after a git or memory_mode update on a non-paginated history,
 * so a later one with the thread's id moves the branch only (a `git` object without one clears
 * it; no `git` keeps it); any other (a fork's copy of its parent's) changes nothing.
 */
export function consumeCodexSessionMeta(
  state: CodexSessionMetaState,
  payload: Record<string, unknown>
): void {
  const { accumulator } = state
  if (state.sawSessionMeta) {
    if (extractString(payload.id) === accumulator.sessionId && asRecord(payload.git)) {
      accumulator.branch = extractGitBranch(payload.git)
    }
    return
  }
  state.nonUserOrigin = readCodexNonUserOrigin(payload)
  if (state.nonUserOrigin) {
    return
  }
  state.sawSessionMeta = true
  state.historyMode = extractString(payload.history_mode)
  const sessionId = extractString(payload.id)
  if (sessionId) {
    accumulator.sessionId = sessionId
  }
  const metadataTitle = extractCodexSessionMetadataTitle(payload)
  if (metadataTitle) {
    accumulator.title = metadataTitle
    state.titleSource = 'meta'
  }
  accumulator.cwd = extractString(payload.cwd) ?? accumulator.cwd
  accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
}
