import type { RuntimeTerminalWatchFocus } from '../../shared/runtime-terminal-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import { writeStdoutLine } from '../output/stdout-line'

// The host answers as soon as focus moves; a long hold keeps a quiet watch to a request a minute.
const WATCH_FOCUS_HOLD_MS = 60_000
// Leaves room for the host's answer once the hold ends.
const WATCH_FOCUS_CLIENT_GRACE_MS = 5_000

/** Prints the focused terminal, then one line each time the window focuses another, until Ctrl-C. */
export const terminalWatchFocusHandler: CommandHandler = async ({ client, json }) => {
  let shown: string | null | undefined
  for (;;) {
    const response = await client.call<{ focus: RuntimeTerminalWatchFocus }>(
      'terminal.watchFocus',
      shown === undefined ? {} : { after: shown, timeoutMs: WATCH_FOCUS_HOLD_MS },
      { timeoutMs: WATCH_FOCUS_HOLD_MS + WATCH_FOCUS_CLIENT_GRACE_MS }
    )
    const { focus } = response.result
    // A hold that ends with no change answers with the pane already printed.
    if (focus.handle !== shown) {
      shown = focus.handle
      writeStdoutLine(json ? JSON.stringify(focus) : `focused: ${focus.handle ?? 'none'}`)
    }
  }
}
