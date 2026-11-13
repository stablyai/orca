import {
  classifyPRCheckRollupResult,
  normalizeRollupCheck,
  type PRCheckRollupResult
} from '../../../shared/source-control/checks/pr-check-status'
import {
  classifyCheckOutcome,
  type CheckOutcome
} from '../../../shared/source-control/checks/provider-check-summary'

/** One check context on one head as of the last occurrence recorded for it. */
export type PRCheckContextState = {
  context: string
  lastState: CheckOutcome | null
  lastRunId: string | null
  pendingSeen: boolean
}

export type PRCheckOccurrenceEvaluation = {
  result: PRCheckRollupResult
  /** Set when this observation is a new final occurrence that reports a line. */
  verdict: 'failure' | 'success' | null
  /** The head's context rows after this observation. */
  contexts: PRCheckContextState[]
  /** The head is final, so it leaves the pending-heads list. */
  final: boolean
}

type ObservedContext = { context: string; state: CheckOutcome; runId: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** A check run reruns as a new run with a new id; a legacy status reruns under a new target URL. */
function observedContext(row: unknown): ObservedContext | null {
  if (!isRecord(row) || row.pendingApproval) {
    return null
  }
  const state = classifyCheckOutcome(normalizeRollupCheck(row))
  if (row.__typename === 'CheckRun') {
    const { name, databaseId: runId } = row
    const suiteId = isRecord(row.checkSuite) ? row.checkSuite.databaseId : undefined
    return typeof name === 'string'
      ? {
          // Workflows may share a job name; the suite tells them apart.
          context: `check:${typeof suiteId === 'number' ? suiteId : ''}:${name}`,
          state,
          runId: typeof runId === 'number' ? String(runId) : null
        }
      : null
  }
  const { context: name, targetUrl: url } = row
  return typeof name === 'string'
    ? { context: `status:${name}`, state, runId: typeof url === 'string' && url ? url : null }
    : null
}

/**
 * Whether a complete observation of one head is a new final occurrence. A context counts as new
 * when its final state changed, a pending state was seen since, or its provider run changed. So a
 * same-verdict rerun is a line even when no read saw it running, and an identical re-post is not.
 */
export function evaluatePRCheckOccurrence(
  rollup: readonly unknown[],
  readComplete: boolean,
  prior: ReadonlyMap<string, PRCheckContextState>
): PRCheckOccurrenceEvaluation {
  const result = classifyPRCheckRollupResult(rollup, readComplete)
  const observed = rollup.flatMap((row) => observedContext(row) ?? [])
  if (!result.final) {
    const contexts = [...prior.values()].map((row) => ({ ...row }))
    const byContext = new Map(contexts.map((row) => [row.context, row]))
    for (const { context, state } of observed) {
      if (state !== 'pending') {
        continue
      }
      const row = byContext.get(context)
      if (row) {
        row.pendingSeen = true
      } else {
        const added = { context, lastState: null, lastRunId: null, pendingSeen: true }
        contexts.push(added)
        byContext.set(context, added)
      }
    }
    return { result, verdict: null, contexts, final: false }
  }
  const changed = observed.some(({ context, state, runId }) => {
    const row = prior.get(context)
    return !row || row.pendingSeen || row.lastState !== state || row.lastRunId !== runId
  })
  return {
    result,
    verdict: changed ? result.verdict : null,
    contexts: observed.map(({ context, state, runId }) => ({
      context,
      lastState: state,
      lastRunId: runId,
      pendingSeen: false
    })),
    final: true
  }
}
