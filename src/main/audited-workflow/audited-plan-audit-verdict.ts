// Reads and parses the Codex plan-audit verdict (Phase 5). PURE parsing plus a
// single bounded file read; no DB, no spawn.
//
// THE VERDICT COMES FROM THE LAST-MESSAGE FILE, NEVER FROM STDOUT.
// Codex `exec` stdout interleaves session banners ("sandbox: read-only",
// "session id: ..."), `hook:` lines, exec traces, and a token-usage footer
// around the answer. `-o/--output-last-message` writes ONLY the agent's final
// message — verified to contain exactly the JSON object and nothing else.
// Scraping stdout would mean parsing adversarially-shaped text that a model can
// influence in many more places, so it is not done at all.
//
// FAIL-CLOSED: every ambiguity resolves to `verdict_unparseable`. There is no
// input — missing file, empty file, oversized file, malformed JSON, or an
// unrecognized verdict string — that can yield an `approved` verdict.
import { rmSync, statSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { REVIEW_VERDICTS, type ReviewVerdict } from '../../shared/audited-workflow-types'

// Bounds the file read itself: a runaway last message must not be loaded whole
// into memory just to be rejected.
export const MAX_LAST_MESSAGE_BYTES = 256 * 1024

// The ONE verdict vocabulary. z.enum over REVIEW_VERDICTS means a value like
// 'accepted' or 'changes_requested' — the vocabulary this feature deliberately
// does NOT use — fails validation rather than being silently mapped.
const VerdictSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  summary: z.string().optional(),
  findings: z
    .array(z.object({ severity: z.string().optional(), text: z.string().optional() }))
    .optional()
})

export type PlanAuditVerdictParseResult =
  | { ok: true; verdict: ReviewVerdict; summary: string; findingCount: number }
  | { ok: false; reasonCode: 'verdict_unparseable' }

const UNPARSEABLE: PlanAuditVerdictParseResult = { ok: false, reasonCode: 'verdict_unparseable' }

/**
 * Parses the last-message text.
 *
 * Accepts a bare JSON object or one wrapped in a fenced block. Takes the LAST
 * balanced top-level object, so a model that narrates before emitting its final
 * answer still parses, while earlier draft objects cannot outrank the final one.
 */
export function parsePlanAuditVerdict(lastMessageText: string): PlanAuditVerdictParseResult {
  if (typeof lastMessageText !== 'string' || !/\S/.test(lastMessageText)) {
    return UNPARSEABLE
  }

  for (const candidate of findJsonCandidates(lastMessageText)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const validated = VerdictSchema.safeParse(parsed)
    if (!validated.success) {
      continue
    }
    return {
      ok: true,
      verdict: validated.data.verdict,
      summary: typeof validated.data.summary === 'string' ? validated.data.summary : '',
      findingCount: validated.data.findings?.length ?? 0
    }
  }

  return UNPARSEABLE
}

/**
 * Returns balanced top-level `{...}` substrings, LAST FIRST.
 *
 * Brace counting is string-aware: a `}` inside a JSON string literal (a summary
 * mentioning "}" or a Windows path) would otherwise close the object early and
 * turn a valid verdict into `verdict_unparseable`.
 */
function findJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) {
        start = index
      }
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, index + 1))
        start = -1
      }
      if (depth < 0) {
        depth = 0
      }
    }
  }

  return candidates.toReversed()
}

export type LastMessageReadResult =
  | { ok: true; text: string }
  | { ok: false; reasonCode: 'verdict_unparseable' }

/**
 * Reads the run-scoped last-message file under its size cap.
 *
 * The path is derived from the canonical run id by the caller, so two runs never
 * share a file and a stale result from a previous run can never be read as this
 * one's. Missing, unreadable, oversized, and empty all collapse to the same
 * closed failure — none of them is a verdict.
 */
export function readLastMessageFile(path: string): LastMessageReadResult {
  const unreadable: LastMessageReadResult = { ok: false, reasonCode: 'verdict_unparseable' }
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_LAST_MESSAGE_BYTES) {
      return unreadable
    }
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    console.error('[auditedWorkflow] Reading the Codex last-message file failed:', error)
    return unreadable
  }
}

/**
 * Removes a run's last-message file.
 *
 * Called on every non-success finalization (cancel, timeout, overflow, spawn
 * failure) so a partially written file can never be mistaken for a completed
 * verdict — and on retry, so a previous attempt's file cannot satisfy a later
 * read. Best-effort: a failure here must not change a run's recorded outcome.
 */
export function removeLastMessageFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Diagnostic-only file; losing the delete never changes an outcome.
  }
}
