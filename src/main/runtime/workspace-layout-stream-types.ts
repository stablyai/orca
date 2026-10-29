import type { ExecutionHostId } from '../../shared/execution-host'

import type { WorkspaceLayoutStreamEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeStore } from './runtime-store-contract'

import type { ProjectionStore } from './workspace-layout-projection'
import type { WorkspaceLayoutStream } from './workspace-layout-stream'
export type LayoutListener = (event: WorkspaceLayoutStreamEvent) => void

export type LayoutOperationCommit = { hostIds: readonly ExecutionHostId[] | null }

export type WorkspaceLayoutReads = Pick<
  WorkspaceLayoutStream,
  'onLayoutOperationCommitted' | 'readPartition'
>

export type StreamStore = ProjectionStore &
  Pick<RuntimeStore, 'onWorkspaceSessionWritten' | 'onWorkspaceSessionOperationEnded'>
