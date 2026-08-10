import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { mobileRepoSelectorFromWorktreeId } from './mobile-pr-create'

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
