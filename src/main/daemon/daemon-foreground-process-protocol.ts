import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
  payload: {
    probeAgentPresence?: AgentProcessIdentity
    captureAgentPresence?: boolean
    /** Optional; an older daemon answers from its cached process table. */
    snapshotNotBeforeMs?: number
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
    expectedIncarnationId?: string
    /** Optional; a daemon that predates it answers with the full capture as it always did. */
    steadyState?: boolean
  }
}
