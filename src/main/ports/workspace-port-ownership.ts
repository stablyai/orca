import path from 'path'
import type { Store } from '../persistence'
import { splitWorktreeId } from '../../shared/worktree-id'
import type {
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import { scanWorkspacePorts } from './local-workspace-port-scanner'

export type WorkspacePortProbeInput = WorkspacePortProbe & {
  connectionId?: string | null
}

export function getStoreWorkspacePortProbes(
  store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
  repoId?: string
): WorkspacePortProbe[] {
  const reposById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
  return Object.entries(store.getAllWorktreeMeta()).flatMap(([worktreeId, meta]) => {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed || (repoId && parsed.repoId !== repoId)) {
      return []
    }
    const repo = reposById.get(parsed.repoId)
    if (!repo || repo.connectionId) {
      return []
    }
    return [
      {
        id: worktreeId,
        repoId: parsed.repoId,
        displayName: meta.displayName || path.basename(parsed.worktreePath),
        path: parsed.worktreePath
      }
    ]
  })
}

export function filterWorkspacePortProbes(
  worktrees: readonly WorkspacePortProbeInput[],
  repoId?: string
): WorkspacePortProbe[] {
  return worktrees.flatMap((worktree) => {
    if ((repoId && worktree.repoId !== repoId) || worktree.connectionId) {
      return []
    }
    return [
      {
        id: worktree.id,
        repoId: worktree.repoId,
        displayName: worktree.displayName || path.basename(worktree.path),
        path: worktree.path
      }
    ]
  })
}

export async function killWorkspacePort(
  worktrees: readonly WorkspacePortProbe[],
  args: WorkspacePortKillRequest
): Promise<WorkspacePortKillResult> {
  if (!Number.isSafeInteger(args.pid) || args.pid <= 0 || !Number.isSafeInteger(args.port)) {
    return { ok: false, reason: 'Invalid process or port.' }
  }

  const scan = await scanWorkspacePorts([...worktrees])
  const port = scan.ports.find(
    (candidate) => candidate.pid === args.pid && candidate.port === args.port
  )

  if (!port) {
    return { ok: false, reason: 'The port is no longer listening.' }
  }
  if (port.kind !== 'workspace') {
    return { ok: false, reason: 'Only workspace-owned local processes can be stopped here.' }
  }
  const pid = port.pid
  if (!pid) {
    return { ok: false, reason: 'The owning process is unknown.' }
  }
  if (pid === process.pid) {
    return { ok: false, reason: 'Orca cannot stop its own process.' }
  }

  try {
    // Why: caller-supplied pids are not trusted; the re-scan above proves
    // this pid still owns the requested workspace listener before SIGTERM.
    process.kill(pid, 'SIGTERM')
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to stop the process.' }
  }
}

export async function scanWorkspacePortProbes(
  worktrees: readonly WorkspacePortProbe[]
): Promise<WorkspacePortScanResult> {
  return scanWorkspacePorts([...worktrees])
}
