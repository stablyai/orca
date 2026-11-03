import { resolve as resolvePath } from 'node:path'
import type { TuiAgent } from '../shared/tui-agent'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { projectGroupIdFromRepoId } from '../shared/folder-workspace-worktree'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { readOrchestrationCompatibilityEvidence } from '../shared/orchestration-compatibility-evidence'
import type { RuntimeWorktreeListResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

type CatalogRow = Pick<RuntimeWorktreeRecord, 'id' | 'path' | 'hostId'> & {
  identity?: { key: string }
  repoId?: string
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

function enclosingCandidatesOnHost<Row extends CatalogRow>(
  catalog: readonly Row[],
  cwd: string,
  hostId: ExecutionHostId
): { row: Row; comparisonPath: string }[] {
  const currentPath = resolvePath(cwd)
  const candidates: { row: Row; comparisonPath: string }[] = []
  for (const row of catalog) {
    if (!isOnCallerHost(row, hostId)) {
      continue
    }
    const rawPath = resolvePath(row.path)
    if (isPathInsideOrEqual(rawPath, currentPath)) {
      // WSL comparison keys are not raw paths; only use them for rank and equivalence.
      candidates.push({ row, comparisonPath: normalizeRuntimePathForComparison(rawPath) })
    }
  }
  return candidates
}

// Index once: ambiguity can contain every catalog row.
function worktreeSelections(rows: readonly CatalogRow[], catalog: readonly CatalogRow[]) {
  const hostsById = new Map<string, Set<string>>()
  for (const row of catalog) {
    const hosts = hostsById.get(row.id) ?? new Set<string>()
    hosts.add(row.hostId ?? LOCAL_EXECUTION_HOST_ID)
    hostsById.set(row.id, hosts)
  }
  return rows.map((row) => ({
    selector:
      (hostsById.get(row.id)?.size ?? 0) > 1 && row.identity?.key
        ? `identity:${row.identity.key}`
        : `id:${row.id}`,
    worktreeId: row.id
  }))
}

export type WorkspaceSelectionPurpose =
  | 'worktree'
  | 'current'
  | 'parent'
  | 'workspace'
  | 'ports'
  | 'orchestration-caller'
  | { agent: TuiAgent }

export function selectorPurpose(flag: string): WorkspaceSelectionPurpose {
  return flag === 'parent-worktree' ? 'parent' : flag === 'workspace' ? 'workspace' : 'worktree'
}

export type HostScopedWorktreeSelection = { selector: string; worktreeId: string }

function enclosingWorkspaceOwners(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string
): CatalogRow[] {
  const candidates = enclosingCandidatesOnHost(catalog, cwd, hostId)
  const depth = Math.max(-1, ...candidates.map(({ comparisonPath }) => comparisonPath.length))
  const innermost = candidates.filter(({ comparisonPath }) => comparisonPath.length === depth)
  const caller = innermost.find(({ row }) => row.id === callerWorktreeId)
  if (caller) {
    return [caller.row]
  }
  const first = innermost[0]
  if (!first) {
    return []
  }
  const owners = new Map<string, CatalogRow>()
  for (const { row, comparisonPath } of innermost) {
    // Only the reserved same-checkout ownership tie changes; project classes remain separate.
    if (
      comparisonPath === first.comparisonPath &&
      row.repoId === first.row.repoId &&
      (row.hostId ?? LOCAL_EXECUTION_HOST_ID) === (first.row.hostId ?? LOCAL_EXECUTION_HOST_ID)
    ) {
      const key = JSON.stringify([row.hostId ?? LOCAL_EXECUTION_HOST_ID, row.id])
      if (!owners.has(key)) {
        owners.set(key, row)
      }
    }
  }
  return [...owners.values()]
}

export function hasEnclosingWorktreeOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId
): boolean {
  return enclosingCandidatesOnHost(catalog, cwd, hostId).length > 0
}

/** Workspace ownership stays separate from project inference: siblings can share a checkout. */
export function selectEnclosingWorktreeSelectionOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): HostScopedWorktreeSelection | undefined {
  const owners = enclosingWorkspaceOwners(catalog, cwd, hostId, callerWorktreeId)
  const selections = worktreeSelections(owners, catalog)
  if (owners.length > 1) {
    const choices = selections.map(({ selector }) => selector)
    const action =
      purpose === 'ports'
        ? 'The port scan did not run. '
        : typeof purpose === 'object'
          ? `${purpose.agent} was not started. `
          : ''
    const flag =
      purpose === 'parent'
        ? '--parent-worktree'
        : purpose === 'workspace'
          ? '--workspace'
          : '--worktree'
    throw new RuntimeClientError(
      'selector_ambiguous',
      `${action}More than one Orca workspace matched the current directory. Choose an exact ${purpose === 'parent' ? 'parent workspace' : 'workspace'}.`,
      {
        workspaces: owners.map((row, index) => ({
          id: row.id,
          path: row.path,
          hostId: row.hostId ?? LOCAL_EXECUTION_HOST_ID,
          selector: choices[index]
        })),
        validSelectorForms: choices,
        nextSteps:
          purpose === 'orchestration-caller'
            ? [
                'This command needs your own caller identity; selecting a target workspace cannot supply it.',
                'Run the command in your own live Orca terminal with ORCA_TERMINAL_HANDLE preserved.'
              ]
            : [
                'Inspect a chosen workspace with `orca worktree show --worktree <selector> --json`.',
                purpose === 'current'
                  ? 'Use the intended action’s target flag to select that workspace; current has no replacement target flag.'
                  : `Pass ${flag} <selector> on your original invocation${purpose === 'ports' ? '; native folders require --all for a host-wide scan' : ''}.`,
                'Pass the exact selector as one argument quoted for your shell.'
              ]
      }
    )
  }
  return selections[0]
}

export function selectEnclosingRepoOnHost(
  catalog: readonly (CatalogRow & Pick<RuntimeWorktreeRecord, 'repoId'>)[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string
): string | undefined {
  const currentPath = resolvePath(cwd)
  const enclosing = enclosingCandidatesOnHost(
    catalog.filter((row) => !projectGroupIdFromRepoId(row.repoId)),
    cwd,
    hostId
  )
  const innermostLength = Math.max(...enclosing.map(({ comparisonPath }) => comparisonPath.length))
  const candidates = enclosing.filter(
    ({ comparisonPath }) => comparisonPath.length === innermostLength
  )
  const checkouts = new Map<string, (typeof catalog)[number]>()
  const callerCheckouts = new Set<string>()
  for (const { row, comparisonPath } of candidates) {
    const key = JSON.stringify([row.repoId, row.hostId ?? LOCAL_EXECUTION_HOST_ID, comparisonPath])
    checkouts.set(key, row)
    if (row.id === callerWorktreeId) {
      callerCheckouts.add(key)
    }
  }
  const matches = [...checkouts]
    .filter(([key]) => callerCheckouts.size === 0 || callerCheckouts.has(key))
    .map(([, row]) => row)
  if (matches.length > 1) {
    const projects = matches
      .map((row) => ({ repo: `id:${row.repoId}`, hostId: row.hostId, path: row.path }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    throw new RuntimeClientError(
      'selector_ambiguous',
      `More than one Orca project contains the current directory: ${currentPath}. Choose the project with --repo or --project.`,
      {
        projects,
        nextSteps: [
          'Run `orca repo list --json` or `orca project list --json`, then pass the intended --repo or --project selector.'
        ]
      }
    )
  }
  return matches[0]?.repoId
}

export function selectWorktreeCreateCwdContext(
  catalog: RuntimeWorktreeListResult['worktrees'],
  cwd: string,
  inferRepo: boolean,
  inferParent = true
): { parentWorktree?: HostScopedWorktreeSelection; parentAmbiguous?: true; repoId?: string } {
  const hostId = getCallerExecutionHostId()
  const repoId = inferRepo
    ? selectEnclosingRepoOnHost(catalog, cwd, hostId, process.env.ORCA_WORKTREE_ID)
    : undefined
  const owners = inferParent
    ? enclosingWorkspaceOwners(catalog, cwd, hostId, process.env.ORCA_WORKTREE_ID)
    : []
  const selections = owners.length ? worktreeSelections(owners.slice(0, 1), catalog) : []
  return {
    repoId,
    parentWorktree: selections[0],
    ...(owners.length > 1 ? { parentAmbiguous: true as const } : {})
  }
}

export function selectEnclosingWorktreeOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): string | undefined {
  return selectEnclosingWorktreeSelectionOnHost(catalog, cwd, hostId, undefined, purpose)?.selector
}

export function selectWorktreeIdOnHost(
  catalog: readonly CatalogRow[],
  worktreeId: string,
  hostId: ExecutionHostId
): string | undefined {
  const match = catalog.find((row) => row.id === worktreeId && isOnCallerHost(row, hostId))
  return match ? worktreeSelections([match], catalog)[0]!.selector : undefined
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
