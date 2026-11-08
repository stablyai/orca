import { useState } from 'react'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../src/shared/github/pull-request-types'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useHostQuery } from '../../query/host-query'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { prAssignableUsersQuery, prRepoParams } from '../../source-control/review/mobile-pr-queries'

export type ReviewerPeople = {
  // Undefined until a read for this repository lands; [] is an accepted empty list.
  users: GitHubAssignableUser[] | undefined
  error: { message: string | null } | null
}

type Target = {
  hostId: string
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubOwnerRepo | null
  /** The open sheet request this list serves, or null once it closed or its PR departed. */
  request: unknown
  search: boolean
}

// The reviewers sheet's candidates, kept per repository: the first search of an open request reads them,
// and every later sheet for that repository starts from that list while it revalidates.
export function useReviewerPeople(target: Target): ReviewerPeople & { demanded: boolean } {
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const [searchedIn, setSearchedIn] = useState<unknown>(null)
  const open = target.request !== null && target.prRepo !== null
  // Demand starts with the first search of an open request and stays until it ends, even if search clears.
  if (open && target.search && searchedIn !== target.request) {
    setSearchedIn(target.request)
  }
  const demanded = open && (target.search || searchedIn === target.request)
  const query = useHostQuery(
    prAssignableUsersQuery,
    { hostId: target.hostId, client: target.client },
    { exec, worktree: target.worktreeId },
    prRepoParams(target.prRepo),
    { enabled: demanded }
  )
  const users = open ? query.data : undefined
  // A dropped connection is not a refusal: the sheet says it is connecting, and the connected edge reads again.
  const refused = query.isError && !isHostNotConnectedError(query.error)
  return {
    users,
    error: open && refused && !users ? { message: query.error?.message || null } : null,
    demanded
  }
}
