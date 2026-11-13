import { formatAddressLines, formatParentLine, type WorkspaceAnnotation } from './workspace-address'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-worktree-contracts'
import {
  formatListingHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'
import { formatWorktreePsTerminalFields } from './worktree-ps-terminal-verdict'
import { formatWorktreePsProgramStatus } from './worktree-ps-program-status'

type AnnotatedPsRow = RuntimeWorktreePsResult['worktrees'][number] & Partial<WorkspaceAnnotation>

export function formatWorktreePs(
  result: WithAnnotatedHostScope<
    Omit<RuntimeWorktreePsResult, 'worktrees'> & { worktrees: AnnotatedPsRow[] }
  >
): string {
  const scope = formatListingHostScope(result.hostScope)
  if (result.worktrees.length === 0) {
    return `No worktrees found.\n${scope}`
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${worktree.repo} ${worktree.branch}  host=${worktree.hostId ?? 'unverifiable'}  ${formatWorktreePsTerminalFields(worktree)}  unread:${worktree.unread ? 'yes' : 'no'}${formatWorktreePsProgramStatus(worktree.agents)}\n${worktree.path}${formatWorktreePsLocation(worktree)}${worktree.preview ? `\npreview: ${worktree.preview}` : ''}`
    )
    .join('\n\n')
  const bodyWithScope = `${body}\n\n${scope}`
  return result.truncated
    ? `${bodyWithScope}\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : bodyWithScope
}

function formatWorktreePsLocation(worktree: AnnotatedPsRow): string {
  const annotation = workspaceAnnotationOf(worktree)
  return annotation
    ? `${formatParentLine(annotation)}${formatAddressLines(annotation)}`
    : formatWorktreePsParent(worktree)
}

/** The parent line, in the sidebar's precedence: worktree, then folder workspace, then another machine. */
function formatWorktreePsParent(worktree: RuntimeWorktreePsResult['worktrees'][number]): string {
  const parent =
    worktree.parentWorktreeId ??
    worktree.workspaceLineage?.parentWorkspaceKey ??
    (worktree.crossStoreParent
      ? `${worktree.crossStoreParent.parent.workspaceKey} on another machine`
      : null)
  return parent ? `\nparent: ${parent}` : ''
}

export function formatWorktreeList(
  result: WithAnnotatedHostScope<RuntimeWorktreeListResult>
): string {
  const scope = formatListingHostScope(result.hostScope)
  if (result.worktrees.length === 0) {
    return `No worktrees found.\n${scope}`
  }
  const body = result.worktrees
    .map((worktree) => {
      const childCount = worktree.childWorktreeIds?.length ?? 0
      return `${String(worktree.id)}  ${String(worktree.branch)}  host=${String(worktree.hostId ?? 'unverifiable')}  ${String(worktree.path)}\ndisplayName: ${String(worktree.displayName ?? '')}\nparentWorktreeId: ${String(worktree.parentWorktreeId ?? 'null')}\nchildWorktreeIds: ${childCount > 0 ? worktree.childWorktreeIds.join(',') : '[]'}\nlinkedIssue: ${String(worktree.linkedIssue ?? 'null')}\ncomment: ${String(worktree.comment ?? '')}`
    })
    .join('\n\n')
  const bodyWithScope = `${body}\n\n${scope}`
  return result.truncated
    ? `${bodyWithScope}\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : bodyWithScope
}

const ANNOTATION_KEYS = new Set(['environment', 'address', 'addressUnavailable', 'parent'])

function workspaceAnnotationOf(record: Partial<WorkspaceAnnotation>): WorkspaceAnnotation | null {
  const { environment, address, addressUnavailable, parent } = record
  return environment
    ? {
        environment,
        address: address ?? null,
        parent: parent ?? null,
        ...(addressUnavailable ? { addressUnavailable } : {})
      }
    : null
}

export function formatWorktreeShow(result: {
  worktree: RuntimeWorktreeRecord & Partial<WorkspaceAnnotation>
}): string {
  const worktree = result.worktree
  const annotation = workspaceAnnotationOf(worktree)
  const fields = Object.entries(worktree)
    .filter(([key]) => !annotation || !ANNOTATION_KEYS.has(key))
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
  return annotation
    ? `${fields}${formatParentLine(annotation)}${formatAddressLines(annotation)}`
    : fields
}
