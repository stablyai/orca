export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
    expectedIncarnationId?: string
  }
}
