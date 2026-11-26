import { formatAddressLines, formatParentLine, type WorkspaceAnnotation } from './workspace-address'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  formatListingHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'

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

export function workspaceAnnotationOf(
  record: Partial<WorkspaceAnnotation>
): WorkspaceAnnotation | null {
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
