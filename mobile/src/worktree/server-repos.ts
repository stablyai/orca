import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { nativeChatRepoListRead } from '../session/mobile-session-read-operations'
import type { Repo as SharedRepo } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'

/** A caller's view of the host's `Repo` records: a few of its own fields, never new ones. */
export type ListedRepo = Pick<SharedRepo, 'id'> & Partial<SharedRepo>

/** One host's repos, or null when it refused or failed to answer. */
export async function listHostRepos<Repo extends ListedRepo>(
  client: RpcClient
): Promise<Repo[] | null> {
  const listed = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo.list rows are the host's Repo records, and Repo is a view of their fields.
  return listed.accepted ? (listed.value as Repo[]) : null
}

/**
 * A server's repos tagged with that server. Its SSH repos are left out: a server cannot serve
 * them, and the phone's SSH gate reads only the desktop's connections.
 */
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
