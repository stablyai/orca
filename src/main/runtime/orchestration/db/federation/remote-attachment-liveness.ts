import type { WorkerDispatchState } from '../orchestration-records'

export const POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES = [
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown'
] as const satisfies readonly WorkerDispatchState[]

export function potentiallyLiveRemoteAttachmentSql(column = 'state'): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) {
    throw new Error(`Invalid remote attachment state column: ${column}`)
  }
  return `${column} IN (${POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.map((state) => `'${state}'`).join(', ')})`
}

/** Whether a federated attachment's worker may still be running, by the same states as the SQL filter. */
export function isPotentiallyLiveRemoteAttachment(
  row: { state: WorkerDispatchState } | undefined
): boolean {
  return POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.some((state) => state === row?.state)
}
