import type {
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceCanvasScope
} from '../../../../shared/runtime-types'

export type MaestroWorkspaceSnapshotState = {
  authorityRevision: number
  sourceCursor: string
  snapshot: RuntimeMaestroWorkspaceCanvasQueryResult & { status: 'available' }
}

export function maestroWorkspaceScopeKey(scope: RuntimeMaestroWorkspaceCanvasScope): string {
  return `${scope.execution_host_id}\0${scope.workspace_key}`
}
