import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { nativeChatRepoListRead } from '../session/mobile-session-read-operations'
import type { Repo as SharedRepo } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'

export type ListedRepo = Pick<SharedRepo, 'id'> & Partial<SharedRepo>

export async function listHostRepos<Repo extends ListedRepo>(
  client: RpcClient
): Promise<Repo[] | null> {
  const listed = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo.list rows are the host's Repo records, and Repo is a view of their fields.
  return listed.accepted ? (listed.value as Repo[]) : null
}

// Exclude server SSH repos: servers cannot serve them and mobile’s SSH gate reads only desktop connections.
export async function listServerRepos<Repo extends ListedRepo>(
  executionHostId: ExecutionHostId,
  client: RpcClient
): Promise<(Repo & { executionHostId: ExecutionHostId })[] | null> {
  const listed = await listHostRepos<Repo>(client).catch(() => null)
  return (
    listed?.filter((repo) => !repo.connectionId).map((repo) => ({ ...repo, executionHostId })) ??
    null
  )
}
