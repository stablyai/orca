import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs
} from '../../shared/runtime-worktree-contracts'

export function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  return result.repos
    .map(
      (repo) =>
        `${repo.id}  ${repo.displayName}  ${repo.path}${typeof repo.hiddenAt === 'number' ? '  (hidden)' : ''}`
    )
    .join('\n')
}

export function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

export function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  return result.truncated ? `${result.refs.join('\n')}\n\ntruncated: yes` : result.refs.join('\n')
}
