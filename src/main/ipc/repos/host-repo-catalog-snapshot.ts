import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../../../shared/host-repo-catalog-contract'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { isAdmissibleDirectSshAuthority } from '../../../shared/ssh-retained-payload-admission'
import { isCurrentSshProviderAuthority } from '../../ssh/ssh-provider-authority'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'

function hasValidCatalogSshAuthority(
  args: ListReposForExecutionHostArgs
): args is Extract<ListReposForExecutionHostArgs, { expectedAuthority: unknown }> {
  if (!('expectedAuthority' in args)) {
    return false
  }
  return isAdmissibleDirectSshAuthority(args.expectedAuthority)
}

function repoHostContradictsConnection(repo: Repo): boolean {
  if (!repo.executionHostId || !repo.connectionId) {
    return false
  }
  const explicitHost = parseExecutionHostId(repo.executionHostId)
  return explicitHost?.kind !== 'ssh' || explicitHost.targetId !== repo.connectionId
}

function getConsistentRepoCatalogForHost(
  repos: readonly Repo[],
  host: NonNullable<ReturnType<typeof parseExecutionHostId>>
): Repo[] | null {
  const hasContradiction = repos.some(
    (repo) =>
      repoHostContradictsConnection(repo) &&
      (getRepoExecutionHostId(repo) === host.id ||
        (host.kind === 'ssh' && repo.connectionId === host.targetId))
  )
  return hasContradiction ? null : repos.filter((repo) => getRepoExecutionHostId(repo) === host.id)
}

export async function listReposForExecutionHost(
  store: Store,
  args: ListReposForExecutionHostArgs
): Promise<HostRepoCatalogSnapshot> {
  const parsedHost = parseExecutionHostId(args?.executionHostId)
  const rejected = (
    reason: Extract<HostRepoCatalogSnapshot, { authoritative: false }>['reason']
  ): HostRepoCatalogSnapshot => ({
    authoritative: false,
    executionHostId: args.executionHostId,
    reason
  })
  if (!parsedHost || parsedHost.kind === 'runtime') {
    return rejected('rejected')
  }
  if (parsedHost.kind === 'local') {
    if ('expectedAuthority' in args) {
      return rejected('rejected')
    }
    const repos = getConsistentRepoCatalogForHost(store.getRepos(), parsedHost)
    if (!repos) {
      return rejected('rejected')
    }
    return {
      authoritative: true,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      repos: structuredClone(repos)
    }
  }
  if (
    !hasValidCatalogSshAuthority(args) ||
    args.expectedAuthority.targetId !== parsedHost.targetId
  ) {
    return rejected('rejected')
  }
  const authority = { ...args.expectedAuthority }
  if (!isCurrentSshProviderAuthority(authority)) {
    return rejected('stale')
  }
  const provider = getSshGitProvider(parsedHost.targetId)
  if (!provider) {
    return rejected('unavailable')
  }
  const matchingRepos = getConsistentRepoCatalogForHost(store.getRepos(), parsedHost)
  if (!matchingRepos) {
    return rejected('rejected')
  }
  const repos = structuredClone(matchingRepos)
  await Promise.resolve()
  if (
    getSshGitProvider(parsedHost.targetId) !== provider ||
    !isCurrentSshProviderAuthority(authority)
  ) {
    return rejected('stale')
  }
  return {
    authoritative: true,
    authority: {
      kind: 'direct-ssh',
      executionHostId: parsedHost.id,
      ...authority
    },
    repos
  }
}
