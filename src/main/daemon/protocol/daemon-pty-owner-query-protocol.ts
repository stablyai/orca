export type CloseStartupQueryAuthorityRequest = {
  id: string
  type: 'closeStartupQueryAuthority'
  payload: { sessionId: string }
}

/** Daemon-wide viewer colours every session answers OSC 10/11 from (v38+). */
export type SetColorQueryReplyColorsRequest = {
  id: string
  type: 'setColorQueryReplyColors'
  payload: { colors: unknown }
}
