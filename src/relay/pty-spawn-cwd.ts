import { statSync } from 'node:fs'
import { parseWorkspaceKey } from '../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import { resolveDefaultCwd } from './pty-shell-utils'

export type RelaySpawnCwdResolution =
  | { kind: 'requested' | 'worktree' | 'workspace-root' | 'host-default'; cwd: string }
  | { kind: 'unresolved'; workspaceId: string }

export function relayHostDirectoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function formatUnresolvedRelaySpawnCwdMessage(workspaceId: string): string {
  return `Cannot determine the working directory for workspace ${workspaceId} on this host. Refusing to start an agent in a fallback directory.`
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Resolve the cwd a relay PTY must spawn in.
 *
 * Why the workspace-root hop: a folder workspace's id is `folder:<uuid>` and carries no path, so
 * the worktree-id split yields nothing and the host default silently won (#15296). The client
 * already delivers the configured root as `ORCA_WORKSPACE_ROOT`; read it before falling back.
 *
 * Existence is checked on the relay host only when the relay is itself the execution host. A
 * worktree path absent here (a Windows relay launching into WSL) stays a miss, not a refusal — the
 * launch wrapper owns that cd. A declared-but-absent folder root is different: we know exactly which
 * directory was meant, so substituting `$HOME` for an agent is the damage this refuses to do.
 *
 * That refusal is only sound when the relay's own filesystem is the one the spawn will use. A WSL
 * shell hands execution to a guest, and a guest path never stats on the Windows relay, so
 * `executesOnRelayFilesystem: false` demotes the refusal back to a miss — the same treatment the
 * worktree branch already gives that host pair.
 */
export function resolveRelaySpawnCwd(args: {
  requestedCwd?: unknown
  worktreeId?: string
  env?: Record<string, string>
  launchAgent?: unknown
  directoryExists?: (path: string) => boolean
  hostDefaultCwd?: () => string
  /** Defaults to true: absent better knowledge, the relay is the execution host. */
  executesOnRelayFilesystem?: boolean
}): RelaySpawnCwdResolution {
  const directoryExists = args.directoryExists ?? relayHostDirectoryExists
  const requested = trimmedString(args.requestedCwd)
  if (requested) {
    return { kind: 'requested', cwd: requested }
  }

  const workspaceId = trimmedString(args.worktreeId) ?? trimmedString(args.env?.ORCA_WORKSPACE_ID)
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const worktreePath =
    scope?.type === 'folder' || !worktreeId
      ? undefined
      : splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (worktreePath && directoryExists(worktreePath)) {
    return { kind: 'worktree', cwd: worktreePath }
  }

  const workspaceRoot = trimmedString(args.env?.ORCA_WORKSPACE_ROOT)
  if (workspaceRoot && directoryExists(workspaceRoot)) {
    return { kind: 'workspace-root', cwd: workspaceRoot }
  }

  // A folder workspace named a root we could not resolve. For an agent that is
  // "cannot determine", not permission to pick one.
  if (
    args.launchAgent !== undefined &&
    args.executesOnRelayFilesystem !== false &&
    (workspaceRoot !== undefined || scope?.type === 'folder')
  ) {
    return { kind: 'unresolved', workspaceId: workspaceId ?? 'unknown' }
  }

  return { kind: 'host-default', cwd: (args.hostDefaultCwd ?? resolveDefaultCwd)() }
}
