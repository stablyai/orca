import type { RecordingScenario } from './recording-scenario'

/**
 * The matrix's `normal` partition replays a result the family already records, so no migrator has
 * to invent a plausible payload per domain. A few sites have no recorded success to replay, and
 * those are inventoried here rather than skipped: a new domain whose scenarios only record failures
 * fails the suite until it is given a fulfilled scenario or a line below. Both directions are
 * checked — an entry whose family has since recorded a success fails too, and family-recordings
 * asserts every entry names a live matrix site — so the list only shrinks.
 */
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
    // b3 is a B-seed: its one scenario exists to reproduce main's refused-issue defect, and the
    // failing pair is the whole point. The payload is the shape the detail loader reads.
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
    // The b2 seed's only recorded success is a null result — the shipped bug it exists to pin — and
    // `result-null` is already its own partition, so replaying it would leave the matrix no control.
    reason: 'the seed records a null result, which the result-null partition already drives',
    result: { ok: true }
  },
  {
    family: 'settings-best-effort',
    request: 'settings.update#1',
    // The write is fire-and-forget; the call site never reads the reply body, so no scenario had a
    // reason to record one. `{ok: true}` is the shape the host sends for an accepted write.
    reason: 'a best-effort write whose reply body no call site reads',
    result: { ok: true }
  }
]

function fulfilledResult(reply: unknown): { found: boolean; result: unknown } {
  if (reply === null || typeof reply !== 'object' || !('result' in reply)) {
    return { found: false, result: undefined }
  }
  const envelope: { ok?: unknown; result?: unknown } = reply
  // Neither an absent/undefined result nor `null` counts: both are partitions of their own, so
  // replaying one as `normal` would leave the site with eight shapes and no success control.
  return envelope.ok === true && envelope.result !== undefined && envelope.result !== null
    ? { found: true, result: envelope.result }
    : { found: false, result: undefined }
}

/** The result the `normal` partition replays at one matrix site. */
export function replyMatrixNormalResult(
  family: string,
  scenarios: readonly RecordingScenario[],
  request: string
): unknown {
  let recorded: { found: boolean; result: unknown } = { found: false, result: undefined }
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      if ('complete' in step && step.complete === request && !recorded.found) {
        recorded = fulfilledResult(step.reply)
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
