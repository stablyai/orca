import type { TerminalWebViewHandle } from './terminal-webview-contract'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

type TerminalViewCommands = Pick<
  TerminalWebViewHandle,
  'resetZoom' | 'cancelSelect' | 'doSelectAll' | 'find' | 'clearFind'
>

// Commands that change what the reader sees, never the PTY bytes, so they need no write ordering.
export function terminalViewCommands(
  postMessage: (msg: TerminalWebViewCommand) => void
): TerminalViewCommands {
  return {
    resetZoom() {
      postMessage({ type: 'reset-zoom' })
    },
    cancelSelect() {
      postMessage({ type: 'cancel-select' })
    },
    doSelectAll() {
      postMessage({ type: 'do-select-all' })
    },
    find(query, direction, incremental) {
      postMessage({ type: 'find', query, direction, incremental })
    },
    clearFind() {
      postMessage({ type: 'clear-find' })
    }
  }
}
