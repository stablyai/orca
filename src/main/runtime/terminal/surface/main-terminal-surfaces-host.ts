import type { PaneStartFactOf } from './pane-start-statuses'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  RuntimeSyncWindowGraph,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-session-contracts'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorkspaceLayoutReads } from './workspace-layout-stream'
import type { BoundTerminal } from './terminal-surface-index'

export type MainTerminalSurfacesHost = {
  store: () => Pick<
    RuntimeStore,
    'getWorkspaceSessionHostIds' | 'getSettings' | 'getWorkspaceSession'
  > | null
  /** Main's one layout projection. */
  reads: () => WorkspaceLayoutReads
  homeHostId: (key: string) => ExecutionHostId | null
  /** The PTY registry's terminal of that id, or null. */
  registered: (ptyId: string) => BoundTerminal | null
  /** Whether the host certified the terminal exited (not merely disconnected or unverifiable). */
  exited: (ptyId: string) => boolean
  /** Whether the terminal runs now. */
  live: (ptyId: string) => boolean
  /** Main's start status of a pane, as the layout stream publishes it. */
  paneStartFact: PaneStartFactOf
  /** The graph authority now, when its graph is ready; null otherwise. */
  readyGraphPublisher: () => number | null
  /** Installs a graph under the publisher's authority, as the window's own publication does. */
  publish: (windowId: number, graph: RuntimeSyncWindowGraph) => void
  /** The session.tabs rows the runtime holds, by workspace. */
  heldRows: () => ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  /** Stores a workspace's rows and pushes them to its subscribers. */
  replaceHeldRows: (worktreeId: string, next: RuntimeMobileSessionTabsSnapshot) => void
  /** The rows less every terminal the window path's exit filters retire. */
  fenceExited: (rows: RuntimeMobileSessionTabsSnapshot) => RuntimeMobileSessionTabsSnapshot
}
