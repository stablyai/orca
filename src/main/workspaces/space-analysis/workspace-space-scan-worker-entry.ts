import { parentPort } from 'node:worker_threads'
import { scanLocalWorkspaceSpaceWorktree } from './workspace-space-local-scan'
import type {
  WorkspaceSpaceScanWorkerRequest,
  WorkspaceSpaceScanWorkerResponse
} from './workspace-space-scan-worker-protocol'

if (!parentPort) {
  throw new Error('Workspace space scan worker requires a parent port.')
}
const port = parentPort

port.on('message', (request: WorkspaceSpaceScanWorkerRequest) => {
  void scanLocalWorkspaceSpaceWorktree(
    request.repo,
    request.worktree,
    request.scannedAt,
    request.duOutput
  ).then(
    (row) => {
      const response: WorkspaceSpaceScanWorkerResponse = { id: request.id, ok: true, row }
      port.postMessage(response)
    },
    (error: unknown) => {
      const response: WorkspaceSpaceScanWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      port.postMessage(response)
    }
  )
})
