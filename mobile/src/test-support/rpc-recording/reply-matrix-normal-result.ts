import { matrixSites } from './reply-matrix'
import type { RecordingScenario } from './recording-scenario'

// Reuse recorded successes as normal controls; explicit inventory covers sites with none.
// Reject missing and stale inventory entries so new failure-only families cannot silently lose controls.
export type ReplyMatrixNormalResult = {
  readonly family: string
  readonly request: string
  readonly reason: string
  readonly result: unknown
}

export const REPLY_MATRIX_NORMAL_RESULT_INVENTORY: readonly ReplyMatrixNormalResult[] = [
  {
    family: 'linear-detail-barrier',
    request: 'linear.getIssue#1',
    reason: 'the seed records the defect, so the family records no fulfilled issue',
    result: { id: 'issue-1', description: 'recorded', labels: [], subIssues: [] }
  },
  {
    family: 'linear-detail-barrier',
    request: 'linear.issueComments#1',
    reason: 'same seed: the comments leg is rejected by design',
    result: { comments: [] }
  },
  {
    family: 'project-explicit-false',
    request: 'github.project.updateIssueBySlug#1',
    reason: 'the seed records a null result, which the result-null partition already drives',
    result: { ok: true }
  },
  {
    family: 'settings-best-effort',
    request: 'settings.update#1',
    reason: 'a best-effort write whose reply body no call site reads',
    result: { ok: true }
  }
]

function fulfilledResult(reply: unknown): { found: boolean; result: unknown } {
  if (reply === null || typeof reply !== 'object' || !('result' in reply)) {
    return { found: false, result: undefined }
  }
  const envelope: { ok?: unknown; result?: unknown } = reply
  // Absent and null already have partitions; neither can serve as a normal success control.
  return envelope.ok === true && envelope.result !== undefined && envelope.result !== null
    ? { found: true, result: envelope.result }
    : { found: false, result: undefined }
}

export function replyMatrixNormalResult(
  family: string,
  scenarios: readonly RecordingScenario[],
  request: string
): unknown {
  let recorded: { found: boolean; result: unknown } = { found: false, result: undefined }
  for (const scenario of scenarios) {
    // Look up frame successes by subscribe payload and occurrence, as the matrix does.
    for (const site of matrixSites(scenario)) {
      if (site.id === request && !recorded.found) {
        recorded = fulfilledResult(site.reply)
      }
    }
  }
  const inventoried = REPLY_MATRIX_NORMAL_RESULT_INVENTORY.find(
    (entry) => entry.family === family && entry.request === request
  )
  if (inventoried) {
    if (recorded.found) {
      throw new Error(
        `${family} ${request} now records a fulfilled reply; drop its REPLY_MATRIX_NORMAL_RESULT_INVENTORY entry`
      )
    }
    return inventoried.result
  }
  if (!recorded.found) {
    throw new Error(
      `No fulfilled reply recorded for matrix site ${family} ${request}. Add a scenario that fulfils it, or list it in REPLY_MATRIX_NORMAL_RESULT_INVENTORY with the reason it cannot be.`
    )
  }
  return recorded.result
}
