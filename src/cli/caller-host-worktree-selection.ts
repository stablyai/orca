import { resolve as resolvePath } from 'node:path'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { readOrchestrationCompatibilityEvidence } from '../shared/orchestration-compatibility-evidence'
import type { RuntimeWorktreeListResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'

type CatalogRow = Pick<RuntimeWorktreeRecord, 'id' | 'path' | 'hostId'> & {
  identity?: { key: string }
}

/** The execution host this CLI process runs on: the SSH target its relay stamped, else this machine. */
export function getCallerExecutionHostId(
  env: Readonly<Record<string, string | undefined>> = process.env
): ExecutionHostId {
  const host = readOrchestrationCompatibilityEvidence(env)?.host
  return host?.kind === 'ssh' ? toSshExecutionHostId(host.targetId) : LOCAL_EXECUTION_HOST_ID
}

// Why: the catalog lists SSH hosts' worktrees too and two hosts can hold the same path, so an SSH
// caller may only take its own host's rows and a local caller none of an SSH host's. `runtime:*`
// rows in this runtime's catalog are checkouts it holds itself, and unstamped rows predate stamping.
function isOnCallerHost(row: CatalogRow, callerHostId: ExecutionHostId): boolean {
  const rowHostId = row.hostId ?? LOCAL_EXECUTION_HOST_ID
  return parseExecutionHostId(callerHostId)?.kind === 'ssh'
    ? rowHostId === callerHostId
    : parseExecutionHostId(rowHostId)?.kind !== 'ssh'
}

// Why: `id:` keeps repo inference and the runtime's scoped fast path; only a bare id that another
// host's row shares needs the exact identity, or the runtime would refuse it as ambiguous.
function toHostScopedSelector(row: CatalogRow, catalog: readonly CatalogRow[]): string {
  const sharedId = catalog.some((other) => other !== row && other.id === row.id)
  return sharedId && row.identity?.key ? `identity:${row.identity.key}` : `id:${row.id}`
}

/** The caller host's innermost worktree enclosing `cwd`, as a selector; undefined when none does. */
export function selectEnclosingWorktreeOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId
): string | undefined {
  const currentPath = resolvePath(cwd)
  let enclosing: CatalogRow | undefined
  let enclosingPathLength = -1
  for (const row of catalog) {
    if (!isOnCallerHost(row, hostId)) {
      continue
    }
    const rowPath = resolvePath(row.path)
    if (!isPathInsideOrEqual(rowPath, currentPath) || rowPath.length <= enclosingPathLength) {
      continue
    }
    enclosing = row
    enclosingPathLength = rowPath.length
  }
  return enclosing ? toHostScopedSelector(enclosing, catalog) : undefined
}

/** Scopes a pane's forwarded bare worktree id to the caller's host; undefined when it has none. */
export function selectWorktreeIdOnHost(
  catalog: readonly CatalogRow[],
  worktreeId: string,
  hostId: ExecutionHostId
): string | undefined {
  const match = catalog.find((row) => row.id === worktreeId && isOnCallerHost(row, hostId))
  return match ? toHostScopedSelector(match, catalog) : undefined
}

/** Scopes a pane's forwarded bare `ORCA_WORKTREE_ID` to the caller's host before it is used. */
export async function resolveCallerPaneWorktreeSelector(
  worktreeId: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const callerHostId = getCallerExecutionHostId()
  if (callerHostId === LOCAL_EXECUTION_HOST_ID) {
    return worktreeId
  }
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  return selectWorktreeIdOnHost(worktrees.result.worktrees, worktreeId, callerHostId)
}
