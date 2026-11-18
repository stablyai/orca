import type { AgentHookServer } from '../server/agent-hook-server'
import {
  createLocalHookPaneRootResolver,
  createLocalPtyInventoryReader,
  type LocalPtyInventoryReader
} from './local-tmux-managed-pty'
import {
  createHookProcessReadSlots,
  createLocalHookRootEvidenceReader,
  hookProcessReadGate
} from '../../../shared/agent-hook-listener/presence/hook-process-root-evidence-reader'
import { readPaneTmuxHost } from '../../../shared/agent-hook-listener/presence/pane-tmux-host-proof'
import {
  readSelectedRows,
  readTerminalRows
} from '../../../shared/agent-hook-listener/presence/tmux-host-attachment-probe'
import { getPtyIdForPaneKey } from '../../ipc/pty/pane/key-state'
import { getLocalPtyProvider } from '../../ipc/pty/provider/registry'

/** Hooks posted on this host name panes its own provider owns; their roots come from that
 *  provider's inventory, read lazily because daemon swaps replace the provider. */
export function installLocalHookRootEvidence(server: AgentHookServer): LocalPtyInventoryReader {
  const readInventory = createLocalPtyInventoryReader({
    getPtyId: getPtyIdForPaneKey,
    listProcesses: () => getLocalPtyProvider().listProcesses()
  })
  if (process.platform !== 'win32') {
    const resolveRoot = createLocalHookPaneRootResolver(readInventory)
    // Root evidence and tmux host probes share one process-read budget; hook admission goes first.
    const slots = createHookProcessReadSlots()
    const gate = hookProcessReadGate(slots, undefined, 1)
    server.setHookRootEvidenceReader(
      createLocalHookRootEvidenceReader(resolveRoot, slots),
      (request) =>
        readPaneTmuxHost(
          {
            resolveRoot,
            readProcesses: (pids) => readSelectedRows(pids, gate).catch(() => []),
            readTerminal: (tty) => readTerminalRows(tty, gate).catch(() => [])
          },
          request
        )
    )
  }
  return readInventory
}
