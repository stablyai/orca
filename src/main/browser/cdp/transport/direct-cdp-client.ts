import type { AgentPointer } from '../input/cdp-page-input-commands'

/** `orca tab cdp` clients draw no agent cursor, and don't wait on a hover move's frame ack or for
 *  the page to finish handling a typed key before it is answered. */
export const DIRECT_CDP_CLIENT_POINTER: AgentPointer = {
  show: async () => {},
  skipsInputWaits: () => true
}
