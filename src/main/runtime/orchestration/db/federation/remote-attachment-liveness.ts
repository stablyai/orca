import type { WorkerDispatchState } from '../../types'

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
