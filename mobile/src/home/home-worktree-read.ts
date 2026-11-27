import type { QueryObserverResult } from '@tanstack/react-query'
import { isHostNotConnectedError } from '../query/host-query-errors'
import type { HomeWorktreeCounts } from '../worktree/catalog/home-host-worktree-fetch'
import type { HomeWorktreeRead } from '../worktree/catalog/home-worktree-info'

export const homeWorktreeRead = (
  result: QueryObserverResult<HomeWorktreeCounts>
): HomeWorktreeRead => ({
  data: result.data,
  dataUpdatedAt: result.dataUpdatedAt,
  // A read refused because the desktop isn't connected yet says nothing about its list.
  failed: result.isError && !isHostNotConnectedError(result.error)
})
