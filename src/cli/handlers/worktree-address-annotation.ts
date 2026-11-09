import type { RuntimeWorktreePsSummary, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import type {
  CrossStoreWorkspaceLineage,
  WorkspaceLineage,
  WorktreeLineage
} from '../../shared/worktree/lineage-types'
import {
  addressableOfPsRow,
  addressableOfShowRecord,
  annotateListing,
  formatParentText
} from '../workspace-address'
import { callerOrcaClient } from './worktree-parent-fields'

/** Annotates `worktree ps` rows; the returned function applies them to any rows aligned by index. */
export async function annotatePsRows(
  client: RuntimeClient,
  rows: readonly RuntimeWorktreePsSummary[]
): Promise<<Row>(aligned: Row[]) => Row[]> {
  const annotations = await annotateListing(
    client,
    () => callerOrcaClient(client),
    rows.map(addressableOfPsRow)
  )
  return (aligned) => aligned.map((row, index) => ({ ...row, ...annotations[index] }))
}

/** A `worktree show` record with its server, address and parent. */
export async function annotateShown<
  Response extends { result: { worktree: RuntimeWorktreeRecord } }
>(client: RuntimeClient, response: Response): Promise<Response> {
  const [annotation] = await annotateListing(client, () => callerOrcaClient(client), [
    addressableOfShowRecord(response.result.worktree)
  ])
  return {
    ...response,
    result: { ...response.result, worktree: { ...response.result.worktree, ...annotation } }
  }
}

type MutationResult = {
  worktree: RuntimeWorktreeRecord
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  crossStoreLineage?: CrossStoreWorkspaceLineage | null
}

/**
 * A create/set result annotated the way `show` is, so its summary prints the same parent line as
 * `ps`. Reporting only: an annotation failure keeps the unannotated result.
 */
export async function annotateMutationResult<Response extends { result: MutationResult }>(
  client: RuntimeClient,
  response: Response
): Promise<{ response: Response; parentText: string | null }> {
  const { worktree, lineage, workspaceLineage, crossStoreLineage } = response.result
  try {
    const [annotation] = await annotateListing(client, () => callerOrcaClient(client), [
      addressableOfShowRecord({
        ...worktree,
        parentWorktreeId: worktree.parentWorktreeId ?? lineage?.parentWorktreeId ?? null,
        workspaceLineage: worktree.workspaceLineage ?? workspaceLineage ?? null,
        crossStoreLineage: worktree.crossStoreLineage ?? crossStoreLineage ?? null
      })
    ])
    return {
      response: {
        ...response,
        result: { ...response.result, worktree: { ...worktree, ...annotation } }
      },
      parentText: formatParentText(annotation)
    }
  } catch {
    return { response, parentText: null }
  }
}
