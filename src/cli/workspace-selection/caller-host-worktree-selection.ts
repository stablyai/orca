import { resolve as resolvePath } from 'node:path'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { projectGroupIdFromRepoId } from '../../shared/folder-workspaces/folder-workspace-worktree'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration/orchestration-compatibility-evidence'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-worktree-contracts'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { refuseUnresolvedOwner, type CatalogRow } from './workspace-catalog-row'
import { createCwdContainment, isOnCallerFilesystem } from './caller-cwd-containment'

/** Group-level folder workspaces join the catalog keyed `folder:<id>`, beside repo-backed rows. */
function isFolderRow(row: CatalogRow): boolean {
  return parseWorkspaceKey(row.id)?.type === 'folder'
}

/** The workspace this Orca terminal belongs to: a repo-backed id or a folder key. */
export function getCallerWorkspaceIds(
  env: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  return [env.ORCA_WORKTREE_ID, env.ORCA_WORKSPACE_ID].flatMap((id) => id?.trim() || [])
}

type CallerWorkspace = string | readonly string[] | undefined

function callerIdsOf(caller: CallerWorkspace): readonly string[] {
  return caller === undefined ? [] : typeof caller === 'string' ? [caller] : caller
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
  const contains = createCwdContainment(cwd, hostId)
  const candidates: { row: Row; comparisonPath: string }[] = []
  for (const row of catalog) {
    if (!row.hostUnresolved && !isOnCallerHost(row, hostId)) {
      continue
    }
    // WSL comparison keys are not raw paths; only use them for rank and equivalence.
    const comparisonPath = contains(row.path, isOnCallerFilesystem(row))
    if (comparisonPath !== null) {
      candidates.push({ row, comparisonPath })
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
    selector: isFolderRow(row)
      ? row.id
      : (hostsById.get(row.id)?.size ?? 0) > 1 && row.identity?.key
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

/** Innermost wins; at equal depth the caller's own workspace wins; otherwise every distinct owner. */
function enclosingWorkspaceOwners(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  caller?: CallerWorkspace
): CatalogRow[] {
  const candidates = enclosingCandidatesOnHost(catalog, cwd, hostId)
  const depth = Math.max(-1, ...candidates.map(({ comparisonPath }) => comparisonPath.length))
  const innermost = candidates.filter(({ comparisonPath }) => comparisonPath.length === depth)
  refuseUnresolvedOwner(innermost.map(({ row }) => row))
  const callerIds = callerIdsOf(caller)
  const own = innermost.find(({ row }) => callerIds.includes(row.id))
  if (own) {
    return [own.row]
  }
  const owners = new Map<string, CatalogRow>()
  for (const { row } of innermost) {
    // Duplicate registrations of one row collapse; every other owner is a distinct choice.
    const key = JSON.stringify([row.hostId ?? LOCAL_EXECUTION_HOST_ID, row.id])
    if (!owners.has(key)) {
      owners.set(key, row)
    }
  }
  return [...owners.values()]
}

/** Workspace ownership stays separate from project inference: siblings can share a checkout. */
export function selectEnclosingWorktreeSelectionOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  caller?: CallerWorkspace,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): HostScopedWorktreeSelection | undefined {
  const owners = enclosingWorkspaceOwners(catalog, cwd, hostId, caller)
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
          kind: isFolderRow(row) ? 'folder workspace' : 'worktree',
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
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string
): string | undefined {
  const currentPath = resolvePath(cwd)
  const enclosing = enclosingCandidatesOnHost(
    catalog.filter((row) => !isFolderRow(row) && !projectGroupIdFromRepoId(row.repoId)),
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
  catalog: readonly CatalogRow[],
  cwd: string,
  inferRepo: boolean,
  inferParent = true
): { parentWorktree?: HostScopedWorktreeSelection; parentAmbiguous?: true; repoId?: string } {
  const hostId = getCallerExecutionHostId()
  const repoId = inferRepo
    ? selectEnclosingRepoOnHost(catalog, cwd, hostId, process.env.ORCA_WORKTREE_ID)
    : undefined
  const owners = inferParent
    ? enclosingWorkspaceOwners(catalog, cwd, hostId, getCallerWorkspaceIds())
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

/** The workspace this Orca terminal names; native folders and the floating terminal have no catalog row. */
export function selectCallerTerminalWorkspace(
  catalog: readonly CatalogRow[],
  hostId: ExecutionHostId
): string | undefined {
  const worktreeId = process.env.ORCA_WORKTREE_ID
  const trimmed = worktreeId?.trim()
  if (isFloatingWorkspaceId(worktreeId)) {
    return undefined
  }
  if (worktreeId && trimmed && !trimmed.startsWith('folder:')) {
    const scoped = selectWorktreeIdOnHost(catalog, worktreeId, hostId)
    if (!scoped) {
      throw new RuntimeClientError(
        'selector_not_found',
        `This terminal's workspace ${worktreeId} is not listed by Orca on this host. Run the command from a workspace directory or pass --worktree <selector> (or all) where the command accepts it.`
      )
    }
    return scoped
  }
  return [trimmed, process.env.ORCA_WORKSPACE_ID?.trim()].find((id) => id?.startsWith('folder:'))
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
