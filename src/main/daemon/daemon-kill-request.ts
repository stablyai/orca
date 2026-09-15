export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
  }
}

export type KillOwnedRequest = {
  id: string
  type: 'killOwned'
  payload: {
    sessionId: string
    expectedIncarnationId: string
    immediate?: boolean
  }
}

export type KillOwnedPayload = KillOwnedRequest['payload']
