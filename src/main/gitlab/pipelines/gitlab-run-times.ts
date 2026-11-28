import { normalizeCheckTimestamp } from '../../../shared/source-control/checks/pr-check-time'

/** GitLab job and pipeline run times, left off when the run hasn't started or finished. */
export function gitLabRunTimes(raw: { started_at?: string | null; finished_at?: string | null }): {
  startedAt?: string
  finishedAt?: string
} {
  const startedAt = normalizeCheckTimestamp(raw.started_at)
  const finishedAt = normalizeCheckTimestamp(raw.finished_at)
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {})
  }
}
