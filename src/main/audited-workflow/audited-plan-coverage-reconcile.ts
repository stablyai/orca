// Reconciles what Codex CLAIMED about coverage against the acceptance criteria
// that actually exist (Phase 6). PURE — no DB, no I/O — so the fail-closed rules
// are testable in isolation, the same shape as decidePlanReviewOutcome.
//
// THE MODEL DOES NOT GET TO DEFINE THE CRITERIA SET. The authoritative criteria
// come from the succeeded triage run via resolveAcceptanceCriteria; this function
// only lets the model annotate them. That is what stops model prose from becoming
// coverage: an id Codex invents has nothing to attach to and is dropped, and a
// criterion Codex ignores is recorded uncovered rather than omitted.
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'
import type { ParsedCoverageEntry } from './audited-plan-audit-verdict'

/**
 * Returns exactly one row per criterion, in criteria order.
 *
 * - Unknown id -> dropped (model invention; there is no criterion to annotate).
 * - Duplicate id -> FIRST wins. Deterministic; a later entry cannot overwrite an
 *   earlier one, so a model that contradicts itself cannot upgrade a criterion to
 *   covered by repeating it.
 * - Missing criterion -> `covered: false`, `note: null`. SILENCE IS NOT COVERAGE.
 *
 * The one-row-per-criterion output is what lets the write path treat "the model
 * sent no coverage at all" and "the model covered nothing" identically, and what
 * makes the PRIMARY KEY (run_id, criterion_id) sufficient to detect a duplicate
 * finalize rather than a merely repetitive response.
 */
export function reconcileCoverage(
  criteria: readonly AuditedAcceptanceCriterion[],
  reported: readonly ParsedCoverageEntry[]
): CoverageRow[] {
  const firstById = new Map<string, ParsedCoverageEntry>()
  for (const entry of reported) {
    if (!firstById.has(entry.id)) {
      firstById.set(entry.id, entry)
    }
  }

  return criteria.map((criterion) => {
    const claim = firstById.get(criterion.id)
    return {
      criterionId: criterion.id,
      covered: claim?.covered ?? false,
      note: claim?.note ?? null
    }
  })
}
