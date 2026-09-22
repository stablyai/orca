import { getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { TerminalInputSourceResolution } from './server/terminal-input-source-route'

/** Answers the hook listener's last-input route from the PTY registry and the runtime's record. */
export function resolveTerminalInputSourceForPane(
  runtime: Pick<OrcaRuntimeService, 'getTerminalInputSource'> | null,
  paneKey: string
): TerminalInputSourceResolution {
  const ptyId = runtime ? getPtyIdForPaneKey(paneKey) : undefined
  if (!runtime || !ptyId) {
    return { pane: 'unknown' }
  }
  return { pane: 'known', source: runtime.getTerminalInputSource(ptyId) }
}
