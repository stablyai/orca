// Resolves the acceptance criteria a Codex plan audit judges against.
//
// MAIN-PROCESS ONLY. The criteria come from the authoritative SUCCEEDED triage
// run — the same durable row resolveNextStepPrompt reads — and never from
// renderer input, which supplies only a taskId. The raw triage artifacts
// (rationale, next-step prompt, provider response) are NOT exposed here or
// through IPC; only the validated criteria the prompt needs.
//
// FAIL-CLOSED. Missing, blank, malformed, or contract-violating stored JSON
// yields a closed reason code rather than a silently empty array. Auditing a
// plan against "no criteria" would let Codex approve work that satisfies
// nothing, which is worse than refusing to start.
import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'

// Mirrors the acceptanceCriteria shape in triage-provider.ts's
// TriageOutputSchema. Re-validated here rather than trusted: the row was written
// by an earlier release whose contract may have differed, and a stored blob is
// not evidence of a current-shape value.
//
// `covered` is accepted as a plain boolean rather than the literal `false` the
// provider schema pins: triage always writes false, but later phases legitimately
// flip it, and a resolver that rejected a covered criterion would break as soon
// as coverage bookkeeping lands.
const StoredCriteriaSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(64),
        text: z.string().trim().min(1).max(500),
        covered: z.boolean()
      })
      .strict()
  )
  .min(1)
  .max(20)

export type ResolvedAcceptanceCriteria =
  | { ok: true; criteria: AuditedAcceptanceCriterion[] }
  | { ok: false; reasonCode: 'acceptance_criteria_unavailable' }

const UNAVAILABLE: ResolvedAcceptanceCriteria = {
  ok: false,
  reasonCode: 'acceptance_criteria_unavailable'
}

/**
 * Returns the validated criteria from the latest SUCCEEDED triage run.
 *
 * Ordered by ended_at_ms DESC to match resolveNextStepPrompt, so the prompt's
 * task framing and its criteria always come from the same triage run.
 */
export function resolveAcceptanceCriteria(
  db: Database.Database,
  taskId: string
): ResolvedAcceptanceCriteria {
  const row = db
    .prepare(
      `SELECT acceptance_criteria_json FROM audited_triage_runs
        WHERE task_id = ? AND status = 'succeeded'
        ORDER BY ended_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { acceptance_criteria_json: string | null } | undefined

  const raw = row?.acceptance_criteria_json ?? null
  if (raw === null || !/\S/.test(raw)) {
    return UNAVAILABLE
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return UNAVAILABLE
  }

  const validated = StoredCriteriaSchema.safeParse(parsed)
  if (!validated.success) {
    return UNAVAILABLE
  }

  return { ok: true, criteria: validated.data }
}
