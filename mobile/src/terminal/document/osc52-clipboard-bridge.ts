import { createOsc52OscHandler } from '../../../../src/shared/osc52-clipboard'
import { notify } from './host-notify'
import type { TerminalDocumentScope, TerminalDocumentTerminal } from './document-scope'

// Deliver OSC 52 to the viewing device using the desktop parser and limits.
export function attachOsc52ClipboardBridge(
  scope: TerminalDocumentScope,
  term: TerminalDocumentTerminal
) {
  term.parser?.registerOscHandler(
    52,
    createOsc52OscHandler({
      // No phone toggle yet; retain desktop’s enabled default for the viewing device.
      getSettingEnabled: () => true,
      // Replay is not fresh copy intent; grant clipboard authority only past its boundary.
      getReplaying: () => !scope.terminalDataRepliesEnabled,
      writeClipboardText: async (text) => notify(scope, { type: 'clipboard-write', text })
    })
  )
}
