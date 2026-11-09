import { randomUUID } from 'node:crypto'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import type { Repo, RepoKind } from '../../../shared/repo-types'

export function createLocalProjectRecord(input: {
  path: string
  kind: RepoKind
  displayName: string
  detected?: Pick<Repo, 'repoIcon' | 'gitRemoteIdentity' | 'upstream'>
}): Repo {
  return {
    id: randomUUID(),
    path: input.path,
    displayName: input.displayName,
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...input.detected,
    addedAt: Date.now(),
    kind: input.kind,
    ...(input.kind === 'git'
      ? {
          externalWorktreeVisibilityLegacy: false,
          // Explicit imports are ready host setups; legacy-repo is reserved for migrated records.
          projectHostSetupMethod: 'imported-existing-folder' as const
        }
      : {})
  }
}
