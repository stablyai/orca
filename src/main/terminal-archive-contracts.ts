import type {
  ArchivedTerminalLayout,
  ArchivedTerminalPane,
  TerminalArchiveReason
} from '../shared/terminal-archive-types'
import type { ExecutionHostId } from '../shared/execution-host'
import type { WorkspaceSessionTerminalTabCloseResult } from '../shared/workspace-session-terminal-tab-close'
import type { TerminalArchiveSourcePaneIdentity } from './terminal-archive-source-pane-signature'

export type ArchiveTerminalTabRequest = {
  operationId: string
  sourceTabId: string
  executionHostId: ExecutionHostId
  runtimeEnvironmentId?: string
  worktreeId: string
  title: string
  defaultTitle?: string
  color?: string | null
  layout: ArchivedTerminalLayout
  panesByLeafId: Record<string, ArchivedTerminalPane>
  sourcePaneIdentityByLeafId: Record<string, TerminalArchiveSourcePaneIdentity>
  reason: TerminalArchiveReason
  createdAt?: number
  capturedAt?: number
  archivedAt?: number
}

export type LostTerminalArchiveRetirement = {
  worktreeId: string
  tabId: string
  executionHostId: ExecutionHostId
  sshTerminationTargetId?: string
}

export type LostTerminalArchiveRetirementResult = WorkspaceSessionTerminalTabCloseResult

export type TerminalArchiveListFilter = { executionHostId?: ExecutionHostId; worktreeId?: string }

export type TerminalArchiveRestoreTarget = { executionHostId?: ExecutionHostId }

export type PruneResult = { prunedIds: string[]; deletedSnapshotRefs: string[] }
