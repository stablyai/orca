import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { normalizeProjectGroups } from '../../../src/shared/project-groups'

export function readRepoProjectGroupId(repo: { projectGroupId?: unknown }): string | null {
  return typeof repo.projectGroupId === 'string' && repo.projectGroupId.length > 0
    ? repo.projectGroupId
    : null
}

export function buildRepoProjectGroupIdByRepoId(
  repos: readonly { id: string; projectGroupId?: unknown }[]
): Map<string, string | null> {
  return new Map(repos.map((repo) => [repo.id, readRepoProjectGroupId(repo)]))
}

export function readProjectGroupListResult(result: unknown): ProjectGroup[] {
  if (!result || typeof result !== 'object') {
    return []
  }
  return normalizeProjectGroups((result as { groups?: unknown }).groups)
}
