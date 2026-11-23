/** How long a worker may wait on its own background task, its turn over, before its coordinator hears. */
const WORKER_BACKGROUND_WAIT_NOTICE_MS = 20 * 60_000

/** The notice bound; a test rig shortens it with ORCA_WORKER_BACKGROUND_WAIT_NOTICE_MS. */
export function workerBackgroundWaitNoticeMs(): number {
  const override = Number(process.env.ORCA_WORKER_BACKGROUND_WAIT_NOTICE_MS)
  return Number.isFinite(override) && override > 0 ? override : WORKER_BACKGROUND_WAIT_NOTICE_MS
}

/** When a wait that began at `since` becomes news. */
export function workerBackgroundWaitDueAt(since: number): number {
  return since + workerBackgroundWaitNoticeMs()
}

/** The bound as a person reads it. */
export function workerBackgroundWaitNoticeText(): string {
  const ms = workerBackgroundWaitNoticeMs()
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`
}
