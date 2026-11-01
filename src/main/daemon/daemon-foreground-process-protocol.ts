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
    expectedIncarnationId?: string
    /** Older daemons ignore this and return a full capture. */
    steadyState?: boolean
    /** Older daemons still count detached daemons as children. */
    ignoreDetached?: boolean
  }
}
