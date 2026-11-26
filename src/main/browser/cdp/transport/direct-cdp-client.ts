import type { AgentPointer } from '../input/cdp-page-input-commands'
import type { AgentPointerInput } from '../../guest-lifecycle/page-activity/browser-agent-activity'

const SHOWN: Promise<void> = Promise.resolve()

/** `orca tab cdp` clients don't wait on a hover move's frame ack or for the page to finish handling
 *  a typed key. Their cursor is echoed after the input is sent, so drawing it never holds the input. */
export function directCdpClientPointer(echo: (input: AgentPointerInput) => void): AgentPointer {
  return {
    show: (input) => {
      setImmediate(() => echo(input))
      return SHOWN
    },
    skipsInputWaits: () => true
  }
}
