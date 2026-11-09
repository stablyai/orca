export type CloseStartupQueryAuthorityRequest = {
  id: string
  type: 'closeStartupQueryAuthority'
  payload: { sessionId: string }
}

/** Daemon-wide viewer colours every session answers OSC 10/11 from (v38+), plus project
 *  colours by repo id (v44+); absent `byRepoId` keeps the daemon's last map. */
export type SetColorQueryReplyColorsRequest = {
  id: string
  type: 'setColorQueryReplyColors'
  payload: { colors: unknown; byRepoId?: unknown }
}
