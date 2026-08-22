import { ipcMain } from 'electron'
import type { BeadsIssuePreset } from '../../shared/beads-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getBeadsWorkspaceStatus, type BeadsExecutionTarget } from '../beads/client'
import {
  clampBeadsIssueLimit,
  getBeadsIssue,
  isBeadsIssueStatus,
  listBeadsIssues,
  updateBeadsIssueStatus,
  type BeadsListStatusScope
} from '../beads/issues'
import { addBeadsIssueComment, getBeadsIssueDetails } from '../beads/issue-details'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { Store } from '../persistence'

const VALID_PRESETS = new Set<BeadsIssuePreset>(['open', 'assigned', 'ready'])

function normalizePreset(value: unknown): BeadsIssuePreset {
  return VALID_PRESETS.has(value as BeadsIssuePreset) ? (value as BeadsIssuePreset) : 'open'
}

const VALID_STATUS_SCOPES = new Set<BeadsListStatusScope>(['open', 'all', 'ready'])

function normalizeStatusScope(value: unknown): BeadsListStatusScope | undefined {
  return VALID_STATUS_SCOPES.has(value as BeadsListStatusScope)
    ? (value as BeadsListStatusScope)
    : undefined
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
    async (
      _event,
      args: {
        repoId: string
        preset?: BeadsIssuePreset
        limit?: number
        statusScope?: BeadsListStatusScope
        assignee?: string
      }
    ) => {
      const target = resolveBeadsTarget(store, args?.repoId)
      const statusScope = normalizeStatusScope(args?.statusScope)
      const assignee =
        typeof args?.assignee === 'string' && args.assignee.trim()
          ? args.assignee.trim()
          : undefined
      return listBeadsIssues(target, {
        preset: normalizePreset(args?.preset),
        ...(statusScope !== undefined ? { statusScope } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        limit: clampBeadsIssueLimit(args?.limit)
      })
    }
  )

  ipcMain.handle('beads:getIssue', async (_event, args: { repoId: string; id: string }) => {
    const target = resolveBeadsTarget(store, args?.repoId)
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return { issue: null }
    }
    return getBeadsIssue(target, args.id.trim())
  })

  ipcMain.handle('beads:getIssueDetails', async (_event, args: { repoId: string; id: string }) => {
    const target = resolveBeadsTarget(store, args?.repoId)
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return { details: null }
    }
    return getBeadsIssueDetails(target, args.id.trim())
  })

  ipcMain.handle(
    'beads:addComment',
    async (_event, args: { repoId: string; id: string; text: string }) => {
      const target = resolveBeadsTarget(store, args?.repoId)
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        throw new Error('Issue id is required')
      }
      if (typeof args?.text !== 'string' || !args.text.trim()) {
        throw new Error('Comment text is required')
      }
      return addBeadsIssueComment(target, args.id.trim(), args.text)
    }
  )

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
