import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { withdrawPane, type TerminalTopologyCommitContext } from './terminal-topology-commit'

export type UnstartedPaneKept = 'bound' | 'starting'

/** Recheck inside the write queue; bindings or starts that arrived meanwhile preserve the pane. */
export function withdrawUnstartedPane(
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>,
  context: TerminalTopologyCommitContext,
  stillStarting: () => boolean
): () => DurableProfileStateMutation<LayoutRefusalCode | UnstartedPaneKept | null> {
  const withdraw = withdrawPane(hostId, pane, context)
  return () => {
    const layout = context.getSession(hostId).terminalLayoutsByTabId?.[pane.tabId]
    if (layout?.ptyIdsByLeafId?.[pane.leafId]) {
      return { value: 'bound', persist: false }
    }
    return stillStarting() ? { value: 'starting', persist: false } : withdraw()
  }
}
