import type {
  DashboardRevealAgentArgs,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../../shared/dashboard-snapshot'
import type {
  TerminalPreviewConnectOptions,
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
  requestSnapshot: () => Promise<void>
  onSnapshot: (callback: (snapshot: DashboardSnapshot) => void) => () => void
  onViewRequested: (callback: (view: 'board' | 'map') => void) => () => void
  revealAgent: (args: DashboardRevealAgentArgs) => Promise<void>
  ackAgent: (paneKey: string) => Promise<void>
  spawnAgent: (args: DashboardSpawnAgentArgs) => Promise<void>
  sleepWorkspace: (args: DashboardSleepWorkspaceArgs) => Promise<void>
}

/** `surfaceId` on every call: which preview of the pty in this window; see TerminalPreviewConnectOptions. */
export type TerminalPreviewApi = {
  connect: (
    ptyId: string,
    opts?: TerminalPreviewConnectOptions
  ) => Promise<TerminalPreviewConnectResult>
  input: (ptyId: string, data: string) => Promise<boolean>
  /** Claim the PTY grid for the preview dialog; resolves to the size actually in effect. */
  fit: (
    ptyId: string,
    cols: number,
    rows: number,
    surfaceId?: string
  ) => Promise<{ cols: number; rows: number } | null>
  ack: (ptyId: string, bytes: number, surfaceId?: string) => Promise<void>
  unsubscribe: (ptyId: string, surfaceId?: string) => Promise<void>
  /** Release several previews' streams and grid claims in one pass; see the main handler for why. */
  detach: (ptyIds: string[], surfaceId?: string) => Promise<void>
  onData: (callback: (payload: TerminalPreviewDataPayload) => void) => () => void
}
