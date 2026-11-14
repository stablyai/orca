import type { FloatingWorkspaceWindowSnapshot } from '../../../shared/floating-workspace-window'

export type FloatingWorkspaceWindowApi = {
  show: (options: { focus: boolean }) => Promise<void>
  hide: () => Promise<void>
  destroy: () => Promise<void>
  publishSnapshot: (snapshot: FloatingWorkspaceWindowSnapshot) => void
  requestSnapshot: () => Promise<FloatingWorkspaceWindowSnapshot | null>
  requestDock: () => void
  /** `explicit` only for a deliberate click; watching the active tab is a view. */
  ackAgent: (paneKey: string, intent: 'view' | 'explicit') => void
  onSnapshot: (callback: (snapshot: FloatingWorkspaceWindowSnapshot) => void) => () => void
  onSnapshotRequested: (callback: () => void) => () => void
  onDockRequested: (callback: () => void) => () => void
  onHiddenByUser: (callback: () => void) => () => void
  /** Acks main admitted from this window; separate from the dashboard's so each is applied once. */
  onAgentAcked: (callback: (paneKey: string, intent: 'view' | 'explicit') => void) => () => void
}
