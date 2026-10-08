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

/** A daemon that predates it answers `Unknown request type`; the client then reads nothing. */
export type ReadTerminalForegroundRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'readTerminalForeground'
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
