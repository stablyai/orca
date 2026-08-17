import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import {
  buildProjectGroupOwnerIndex,
  getNextProjectGroupOrder,
  resolveProjectGroupOwner
} from '../../../shared/project-groups'

export function moveProjectToGroupForOwner(args: {
  state: PersistedState
  repoId: string
  groupId: string | null
  order?: number
  ownerHostId?: ExecutionHostId
  hydrateRepo: (repo: Repo) => Repo
  scheduleSave: () => void
}): Repo | null {
  const hasExplicitOwner = args.ownerHostId !== undefined
  if (hasExplicitOwner && !parseExecutionHostId(args.ownerHostId)) {
    return null
  }
  const matchingRepos = args.state.repos.filter(
    (entry) =>
      entry.id === args.repoId &&
      (!hasExplicitOwner || getRepoExecutionHostId(entry) === args.ownerHostId)
  )
  if (matchingRepos.length !== 1) {
    return null
  }
  const repo = matchingRepos[0]
  const repoOwnerHostId = getRepoExecutionHostId(repo)
  if (
    args.groupId !== null &&
    !resolveProjectGroupOwner(
      buildProjectGroupOwnerIndex(args.state.projectGroups ?? []),
      args.groupId,
      repoOwnerHostId
    )
  ) {
    return null
  }
  const siblingRepos = args.state.repos.filter(
    (entry) => entry !== repo && getRepoExecutionHostId(entry) === repoOwnerHostId
  )
  repo.projectGroupId = args.groupId
  repo.projectGroupOrder =
    typeof args.order === 'number' && Number.isFinite(args.order)
      ? args.order
      : getNextProjectGroupOrder(siblingRepos, args.groupId)
  args.scheduleSave()
  return args.hydrateRepo(repo)
}
