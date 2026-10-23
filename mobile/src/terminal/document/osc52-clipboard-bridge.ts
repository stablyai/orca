import { createOsc52OscHandler } from '../../../../src/shared/osc52-clipboard'
import { notify } from './host-notify'
import type { TerminalDocumentScope, TerminalDocumentTerminal } from './document-scope'

/**
 * OSC 52 copies (Claude Code's /btw `c`, tmux, Neovim over SSH) land on the device viewing the
 * terminal, through the parser and limits desktop uses.
 */
export function attachOsc52ClipboardBridge(
  scope: TerminalDocumentScope,
  term: TerminalDocumentTerminal
) {
  term.parser?.registerOscHandler(
    52,
    createOsc52OscHandler({
      // Why: the toggle belongs to the viewing device, and the phone has none yet; desktop's default is on.
      getSettingEnabled: () => true,
      // Why: parser replies earn authority only past the replay boundary; a copy needs the same fresh intent.
      getReplaying: () => !scope.terminalDataRepliesEnabled,
      writeClipboardText: async (text) => notify(scope, { type: 'clipboard-write', text })
    })
  )
}
