import type { AgentHookServer } from './server'
import {
  createLocalHookPaneRootResolver,
  createLocalPtyInventoryReader,
  type LocalPtyInventoryReader
} from './local-tmux-managed-pty'
import { createLocalHookRootEvidenceReader } from '../../shared/hook-process-root-evidence-reader'
import { getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'

/** Hooks posted on this host name panes its own provider owns; their roots come from that
 *  provider's inventory, read lazily because daemon swaps replace the provider. */
export function installLocalHookRootEvidence(server: AgentHookServer): LocalPtyInventoryReader {
  const readInventory = createLocalPtyInventoryReader({
    getPtyId: getPtyIdForPaneKey,
    listProcesses: () => getLocalPtyProvider().listProcesses()
  })
  if (process.platform !== 'win32') {
    server.setHookRootEvidenceReader(
      createLocalHookRootEvidenceReader(createLocalHookPaneRootResolver(readInventory))
    )
  }
  return readInventory
}
