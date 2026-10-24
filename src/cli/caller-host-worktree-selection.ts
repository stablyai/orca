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

/** SSH relays stamp the caller host; otherwise use this machine. */
export function getCallerExecutionHostId(
  env: Readonly<Record<string, string | undefined>> = process.env
): ExecutionHostId {
  const host = readOrchestrationCompatibilityEvidence(env)?.host
  return host?.kind === 'ssh' ? toSshExecutionHostId(host.targetId) : LOCAL_EXECUTION_HOST_ID
}

// Paths may exist on multiple hosts; runtime:* and unstamped rows belong to this runtime.
function isOnCallerHost(row: CatalogRow, callerHostId: ExecutionHostId): boolean {
  const rowHostId = row.hostId ?? LOCAL_EXECUTION_HOST_ID
  return parseExecutionHostId(callerHostId)?.kind === 'ssh'
    ? rowHostId === callerHostId
    : parseExecutionHostId(rowHostId)?.kind !== 'ssh'
}

// Prefer id: for repo inference; shared IDs need an exact host-qualified identity.
function toHostScopedSelector(row: CatalogRow, catalog: readonly CatalogRow[]): string {
  const sharedId = catalog.some((other) => other !== row && other.id === row.id)
  return sharedId && row.identity?.key ? `identity:${row.identity.key}` : `id:${row.id}`
}

export type HostScopedWorktreeSelection = { selector: string; worktreeId: string }

/** Prefer the innermost enclosing worktree on the caller's host. */
export function selectEnclosingWorktreeSelectionOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId
): HostScopedWorktreeSelection | undefined {
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
  return enclosing
    ? { selector: toHostScopedSelector(enclosing, catalog), worktreeId: enclosing.id }
    : undefined
}

export function selectEnclosingWorktreeOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId
): string | undefined {
  return selectEnclosingWorktreeSelectionOnHost(catalog, cwd, hostId)?.selector
}

export function selectWorktreeIdOnHost(
  catalog: readonly CatalogRow[],
  worktreeId: string,
  hostId: ExecutionHostId
): string | undefined {
  const match = catalog.find((row) => row.id === worktreeId && isOnCallerHost(row, hostId))
  return match ? toHostScopedSelector(match, catalog) : undefined
}

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
