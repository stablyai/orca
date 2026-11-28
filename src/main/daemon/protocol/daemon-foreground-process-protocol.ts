import type { PtyProcessInspectionOptions } from '../../providers/pty/process-inspection'
export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
  payload: {
    sessionId: string
  }
}

export type ConfirmForegroundProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmForegroundProcess'
}

export type ConfirmShellForegroundRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmShellForeground'
}

export type InspectProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'inspectProcess'
  payload: GetForegroundProcessRequest['payload'] & {
    foregroundOnly?: boolean
    expectedIncarnationId?: string
    runningWorkSinceMs?: number
    /** Older daemons ignore this and return a full capture. */
    steadyState?: boolean
    /** Older daemons ignore this and do their full child inspection. */
    jobMembershipOnly?: boolean
    /** Older daemons still count detached daemons as children. */
    ignoreDetached?: boolean
  }
}

export type CancelProcessInspectionRequest = {
  id: string
  type: 'cancelProcessInspection'
  payload: { requestId: string }
}

export function inspectProcessOptions(
  payload: InspectProcessRequest['payload']
): PtyProcessInspectionOptions {
  return {
    ...(payload.foregroundOnly === true ? { foregroundOnly: true } : {}),
    ...(typeof payload.runningWorkSinceMs === 'number' &&
    Number.isSafeInteger(payload.runningWorkSinceMs)
      ? { runningWorkSinceMs: payload.runningWorkSinceMs }
      : {}),
    ...(payload.expectedIncarnationId
      ? { expectedIncarnationId: payload.expectedIncarnationId }
      : {}),
    ...(payload.steadyState === true ? { steadyState: true } : {}),
    ...(payload.jobMembershipOnly === true ? { jobMembershipOnly: true } : {}),
    ...(payload.ignoreDetached === true ? { ignoreDetached: true } : {})
  }
}
