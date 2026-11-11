import type { RuntimeWorktreePsSummary, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import { addressableOfPsRow, addressableOfShowRecord, annotateListing } from '../workspace-address'
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

/** A `worktree show` record with its environment, address and parent. */
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
