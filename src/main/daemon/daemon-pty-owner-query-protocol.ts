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

/** Viewer attributes (palette, colours, scheme, cursor) a delegated responder answers from (v45+). */
export type SetTerminalViewAttributesRequest = {
  id: string
  type: 'setTerminalViewAttributes'
  payload: { attributes: unknown }
}

/** Main hands a view-gated session's query replies to the daemon, or takes them back (v45+).
 *  The daemon acknowledges in byte order with a sessionQueryResponderMarker stream event. */
export type SetSessionQueryResponderRequest = {
  id: string
  type: 'setSessionQueryResponder'
  payload: { sessionId: string; responder: boolean; nativeWindowsConpty?: boolean }
}
