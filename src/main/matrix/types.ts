// Domain types for the Matrix adapter. Kept free of matrix-js-sdk imports so the
// service/IPC surface stays a thin, stable contract the rest of Orca depends on.

export type MatrixConfig = {
  homeserver: string
  userId: string
  roomId: string
}

export type MatrixViewer = {
  userId: string
  displayName?: string
  homeserver: string
}

export type MatrixConnectionStatus = {
  ok: boolean
  enabled: boolean
  running: boolean
  viewer?: MatrixViewer
  roomId?: string
  error?: string
}

export type InboundMatrixMessage = {
  eventId: string
  roomId: string
  sender: string
  body: string
  html?: string
  ts: number
  inReplyToEventId?: string
}

export type OutboundResult = { ok: true; eventId: string } | { ok: false; error: string }

// Classified Matrix failures. Callers surface `message` in-band (project doctrine:
// loud = the working path sees the failure, not just a log line).
export type MatrixErrorType = 'auth' | 'network' | 'forbidden' | 'rate_limit' | 'unknown'

export type ClassifiedMatrixError = {
  type: MatrixErrorType
  message: string
}
