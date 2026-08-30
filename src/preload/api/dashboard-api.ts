import type {
  DashboardOpenFileArgs,
  DashboardRevealAgentArgs,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../../shared/dashboard-snapshot'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../shared/terminal-preview'

export type DashboardApi = {
  openPopout: (view?: 'board' | 'map') => Promise<void>
  publishSnapshot: (snapshot: DashboardSnapshot) => Promise<void>
  getPopoutOpen: () => Promise<boolean>
  onPopoutOpenChanged: (callback: (open: boolean) => void) => () => void
  onSnapshotRequested: (callback: () => void) => () => void
  onRevealAgent: (callback: (args: DashboardRevealAgentArgs) => void) => () => void
  onAckAgent: (callback: (paneKey: string) => void) => () => void
  onSpawnAgent: (callback: (args: DashboardSpawnAgentArgs) => void) => () => void
  onSleepWorkspace: (callback: (args: DashboardSleepWorkspaceArgs) => void) => () => void
  onOpenFile: (callback: (args: DashboardOpenFileArgs) => void) => () => void
  requestSnapshot: () => Promise<void>
  onSnapshot: (callback: (snapshot: DashboardSnapshot) => void) => () => void
  onViewRequested: (callback: (view: 'board' | 'map') => void) => () => void
  revealAgent: (args: DashboardRevealAgentArgs) => Promise<void>
  ackAgent: (paneKey: string) => Promise<void>
  spawnAgent: (args: DashboardSpawnAgentArgs) => Promise<void>
  sleepWorkspace: (args: DashboardSleepWorkspaceArgs) => Promise<void>
  openFile: (args: DashboardOpenFileArgs) => Promise<void>
}

export type TerminalPreviewApi = {
  connect: (
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<TerminalPreviewConnectResult>
  input: (ptyId: string, data: string) => Promise<boolean>
  /** Claim the PTY grid for the preview dialog; resolves to the size actually in effect. */
  fit: (ptyId: string, cols: number, rows: number) => Promise<{ cols: number; rows: number } | null>
  ack: (ptyId: string, bytes: number) => Promise<void>
  unsubscribe: (ptyId: string) => Promise<void>
  onData: (callback: (payload: TerminalPreviewDataPayload) => void) => () => void
}
