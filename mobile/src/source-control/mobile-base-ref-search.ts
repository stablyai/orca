import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { mobileRepoSelectorFromWorktreeId } from './mobile-pr-create'

// Base-branch selection for the create-PR composer, mirroring the desktop
// useCreatePullRequestDialogFields flow: a default ref from repo.baseRefDefault and
// a debounced search via repo.searchRefs (both allowlisted for mobile). Result
// mapping is pure + unit-tested; the wrappers are thin sendRequest calls.

// Defensively normalize the repo.searchRefs payload (`{ refs: string[] }`) to a
// clean string[] — drops non-string / malformed entries instead of throwing.
export function mapBaseRefResults(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') {
    return []
  }
  const refs = (raw as { refs?: unknown }).refs
  if (!Array.isArray(refs)) {
    return []
  }
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0)
}

export async function fetchDefaultBaseRef(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<string | null> {
  const response = await client.sendRequest('repo.baseRefDefault', {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId)
  })
  if (!response.ok) {
    return null
  }
  const result = (response as RpcSuccess).result as { defaultBaseRef?: string | null }
  return typeof result?.defaultBaseRef === 'string' ? result.defaultBaseRef : null
}

export async function searchBaseRefs(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  query: string,
  limit = 20
): Promise<string[]> {
  const response = await client.sendRequest('repo.searchRefs', {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    query,
    limit
  })
  if (!response.ok) {
    return []
  }
  return mapBaseRefResults((response as RpcSuccess).result)
}
