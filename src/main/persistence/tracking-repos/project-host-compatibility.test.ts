import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { mergeProjectHostSetupCompatibilityState } from './project-host-compatibility'

const PROJECT_ID = 'github:acme/orca'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/src/${overrides.id}`,
    displayName: 'orca',
    addedAt: 1,
    upstream: { owner: 'acme', repo: 'orca' },
    ...overrides
  } as Repo
}

function pendingSetup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: `${PROJECT_ID}::ssh:devbox`,
    projectId: PROJECT_ID,
    hostId: 'ssh:devbox',
    repoId: '',
    path: '',
    displayName: 'orca',
    setupState: 'not-set-up',
    setupMethod: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ProjectHostSetup
}

describe('mergeProjectHostSetupCompatibilityState', () => {
  it('keeps a placeholder for a host with no repo yet', () => {
    const merged = mergeProjectHostSetupCompatibilityState(
      { projects: [], projectHostSetups: [pendingSetup()] },
      [repo({ id: 'local-repo' })]
    )

    expect(merged.projectHostSetups.map((setup) => setup.hostId)).toEqual(['local', 'ssh:devbox'])
  })

  // Setting a location on a host that already had a placeholder projects a ready setup for
  // the same project+host; the placeholder must not survive to shadow it.
  it('drops a placeholder once a repo covers the same project and host', () => {
    const merged = mergeProjectHostSetupCompatibilityState(
      { projects: [], projectHostSetups: [pendingSetup()] },
      [repo({ id: 'local-repo' }), repo({ id: 'devbox-repo', executionHostId: 'ssh:devbox' })]
    )

    expect(merged.projectHostSetups).toHaveLength(2)
    expect(merged.projectHostSetups.every((setup) => setup.setupState === 'ready')).toBe(true)
    expect(merged.projectHostSetups.map((setup) => setup.id)).toEqual(['local-repo', 'devbox-repo'])
  })

  it('keeps the placeholder when the repo covers a different host', () => {
    const merged = mergeProjectHostSetupCompatibilityState(
      { projects: [], projectHostSetups: [pendingSetup({ hostId: 'ssh:other' })] },
      [repo({ id: 'devbox-repo', executionHostId: 'ssh:devbox' })]
    )

    expect(merged.projectHostSetups.map((setup) => setup.hostId)).toEqual([
      'ssh:devbox',
      'ssh:other'
    ])
  })
})
