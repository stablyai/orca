import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import { hostQueryKey, type HostQueryTarget } from '../../../../query/host-query-key'
import { hostReadClient } from '../../../../query/host-read-client'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { prDetailsQuery, type PrDetailsInput } from '../mobile-pr-queries'
import { acceptPrComments, PrCommentsUnavailableError, readPrComments } from './pr-comment-read'

const unsupported = new WeakMap<RpcClient, Map<HostQueryTarget['exec'], number>>()

export async function pollPrComments(
  queryClient: QueryClient,
  client: RpcClient,
  hostId: string,
  target: HostQueryTarget,
  input: PrDetailsInput,
  signal: AbortSignal,
  hasPendingWrites: () => boolean
): Promise<null> {
  const key = hostQueryKey(hostId, prDetailsQuery.family, target, input)
  const before = queryClient.getQueryState<GitHubWorkItemDetails>(key)
  if (!before || before.fetchStatus !== 'idle' || signal.aborted || hasPendingWrites()) {
    return null
  }
  const generation = client.getGeneration?.() ?? 0
  const current = () =>
    !signal.aborted &&
    !hasPendingWrites() &&
    (client.getGeneration?.() ?? 0) === generation &&
    queryClient.getQueryState(key) === before
  const fullRead = () => queryClient.invalidateQueries({ queryKey: key, exact: true })
  if (!before.data || unsupported.get(client)?.get(target.exec) === generation) {
    await fullRead()
    return null
  }
  try {
    const comments = await readPrComments(
      hostReadClient(client),
      target.worktree ?? '',
      input,
      false
    )
    if (current()) {
      // The sidebar uses this timestamp to decide whether the rest of the PR needs reloading.
      acceptPrComments(queryClient, key, comments, before.dataUpdatedAt)
    }
  } catch (error) {
    if (!(error instanceof PrCommentsUnavailableError)) {
      throw error
    }
    if (current()) {
      const hosts = unsupported.get(client) ?? new Map()
      hosts.set(target.exec, generation)
      unsupported.set(client, hosts)
      await fullRead()
    }
  }
  return null
}

export function usePrCommentPolling(
  { hostId, client }: { hostId: string; client: RpcClient | null },
  target: HostQueryTarget,
  input: PrDetailsInput,
  refetchInterval: number | false,
  hasPendingWrites: () => boolean
): void {
  const queryClient = useQueryClient()
  useQuery({
    queryKey: hostQueryKey(hostId, 'pr.commentPoll', target, input),
    queryFn: client
      ? ({ signal }) =>
          pollPrComments(queryClient, client, hostId, target, input, signal, hasPendingWrites)
      : skipToken,
    enabled: refetchInterval !== false,
    // The details query provides the initial conversation; this observer only owns subsequent polls.
    initialData: null,
    staleTime: 'static',
    notifyOnChangeProps: [],
    refetchInterval
  })
}
