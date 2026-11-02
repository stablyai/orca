import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'

export type WorkspaceSpaceScanWorkerRequest = {
  id: number
  repo: Repo
  worktree: Worktree
  scannedAt: number
  duOutput: string | null
}

export type WorkspaceSpaceScanWorkerResponse =
  | { id: number; ok: true; row: WorkspaceSpaceWorktree }
  | { id: number; ok: false; error: string }
