export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
    /** Refuse unless the session on this id is still this incarnation. */
    expectedIncarnationId?: string
  }
}

export type ConsumeExitReceiptRequest = {
  id: string
  type: 'consumeExitReceipt'
  payload: { sessionId: string; incarnationId: string }
}
