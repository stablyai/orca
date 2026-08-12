import { ipcMain } from 'electron'
import type { BeadsIssuePreset } from '../../shared/beads-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getBeadsWorkspaceStatus, type BeadsExecutionTarget } from '../beads/client'
import {
  clampBeadsIssueLimit,
  getBeadsIssue,
  isBeadsIssueStatus,
  listBeadsIssues,
  updateBeadsIssueStatus
} from '../beads/issues'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { Store } from '../persistence'

const VALID_PRESETS = new Set<BeadsIssuePreset>(['open', 'assigned', 'ready'])

function normalizePreset(value: unknown): BeadsIssuePreset {
  return VALID_PRESETS.has(value as BeadsIssuePreset) ? (value as BeadsIssuePreset) : 'open'
}

function resolveBeadsTarget(store: Store, repoId: unknown): BeadsExecutionTarget {
  if (typeof repoId !== 'string' || !repoId.trim()) {
    throw new Error('Repo id is required')
  }
  const repo = store.getRepos().find((candidate) => candidate.id === repoId)
  if (!repo) {
    throw new Error('Access denied: unknown repository')
  }
  // Why: runtime-host repos live on a paired remote Orca; the renderer must
  // reach them via the beads.* runtime RPC, never this local IPC surface.
  if (getRepoExecutionHostId(repo).startsWith('runtime:')) {
    throw new Error('Beads for runtime-host repos must go through the runtime RPC')
  }
  const localGitOptions = repo.connectionId ? {} : getLocalProjectWorktreeGitOptions(store, repo)
  return {
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
}

export function registerBeadsHandlers(store: Store): void {
  ipcMain.handle('beads:getStatus', async (_event, args: { repoId: string }) => {
    const target = resolveBeadsTarget(store, args?.repoId)
    return { status: await getBeadsWorkspaceStatus(target) }
  })

  ipcMain.handle(
    'beads:listIssues',
    async (_event, args: { repoId: string; preset?: BeadsIssuePreset; limit?: number }) => {
      const target = resolveBeadsTarget(store, args?.repoId)
      return listBeadsIssues(
        target,
        normalizePreset(args?.preset),
        clampBeadsIssueLimit(args?.limit)
      )
    }
  )

  ipcMain.handle('beads:getIssue', async (_event, args: { repoId: string; id: string }) => {
    const target = resolveBeadsTarget(store, args?.repoId)
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return { issue: null }
    }
    return getBeadsIssue(target, args.id.trim())
  })

  ipcMain.handle(
    'beads:updateIssue',
    async (_event, args: { repoId: string; id: string; status: string }) => {
      const target = resolveBeadsTarget(store, args?.repoId)
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('Issue id is required')
      }
      if (!isBeadsIssueStatus(args?.status)) {
        throw new Error('Invalid beads issue status')
      }
      return updateBeadsIssueStatus(target, args.id.trim(), args.status)
    }
  )
}
