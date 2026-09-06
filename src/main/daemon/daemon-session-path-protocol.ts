// The two daemon requests that read a session's filesystem identity: its working
// directory and the PTY slave device backing it.
//
// Split out of `types.ts` because that module sits at the 300-line budget and the
// ratchet requires new growth to move into a sibling rather than take a bypass.

export type GetCwdRequest = {
  id: string
  type: 'getCwd'
  payload: {
    sessionId: string
  }
}

export type GetSlavePathRequest = {
  id: string
  type: 'getSlavePath'
  payload: {
    sessionId: string
  }
}
