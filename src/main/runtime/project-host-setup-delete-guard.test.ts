// `orca project setup-delete` used to drop a repo-backed project even while its terminals were
// running and its workspaces had saved details, orphaning both with no warning.
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import {
  countRepoTerminalsNotKnownExited,
  countRepoWorkspacesWithMetadata
} from './project-removal-impact'

const repo: Repo = {
  id: 'repo-1',
  path: '/work/app',
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git'
}

function makeController(options: {
  liveTerminals: number
  metaIds: string[]
  canonicalMetaIdsForHost?: string[]
  targetRepo?: Repo
}) {
  const targetRepo = options.targetRepo ?? repo
  const { projects, setups: projectHostSetups } = projectHostSetupProjectionFromRepos([targetRepo])
  const deleteProjectHostSetup = vi.fn(() => ({
    project: projects[0],
    setup: projectHostSetups[0],
    repo: targetRepo
  }))
  const store = {
    getProjects: () => projects,
    getProjectHostSetups: () => projectHostSetups,
    getAllWorktreeMeta: () =>
      Object.fromEntries(options.metaIds.map((id) => [id, { hostId: undefined }])),
    getAllWorktreeMetaForHost: (hostId: string) =>
      options.canonicalMetaIdsForHost
        ? Object.fromEntries(options.canonicalMetaIdsForHost.map((id) => [id, { hostId }]))
        : undefined,
    deleteProjectHostSetup
  }
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [targetRepo],
    addRepo: vi.fn(),
    addRemoteRepo: vi.fn(),
    cloneRepo: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn(),
    countLiveTerminalsForRepo: () => options.liveTerminals
  })
  return { controller, deleteProjectHostSetup, setupId: projectHostSetups[0].id }
}

describe('project setup delete guard', () => {
  it('refuses a CLI delete while terminals are live, and deletes with --force', () => {
    const { controller, deleteProjectHostSetup, setupId } = makeController({
      liveTerminals: 2,
      metaIds: []
    })

    expect(() => controller.deleteSetup({ setupId, force: false })).toThrow(
      /2 terminals still open.*--force/
    )
    expect(deleteProjectHostSetup).not.toHaveBeenCalled()

    controller.deleteSetup({ setupId, force: true })
    expect(deleteProjectHostSetup).toHaveBeenCalledTimes(1)
  })

  it('refuses while workspaces have saved details', () => {
    const { controller, deleteProjectHostSetup, setupId } = makeController({
      liveTerminals: 0,
      metaIds: ['repo-1::/work/app', 'other-repo::/work/other']
    })

    expect(() => controller.deleteSetup({ setupId, force: false })).toThrow(
      /saved details for 1 workspace\./
    )
    expect(deleteProjectHostSetup).not.toHaveBeenCalled()
  })

  it('sees sibling-host metadata kept only in the host-qualified maps', () => {
    // Same repo id and path on local and SSH: the raw-id map holds only the local row.
    const { controller, deleteProjectHostSetup, setupId } = makeController({
      liveTerminals: 0,
      metaIds: ['repo-1::/work/app'],
      canonicalMetaIdsForHost: ['repo-1::/work/app'],
      targetRepo: { ...repo, connectionId: 'box' }
    })

    expect(() => controller.deleteSetup({ setupId, force: false })).toThrow(
      /saved details for 1 workspace\./
    )
    expect(deleteProjectHostSetup).not.toHaveBeenCalled()
  })

  it('deletes an unused project without --force', () => {
    const { controller, deleteProjectHostSetup, setupId } = makeController({
      liveTerminals: 0,
      metaIds: ['other-repo::/work/other']
    })

    controller.deleteSetup({ setupId, force: false })
    expect(deleteProjectHostSetup).toHaveBeenCalledTimes(1)
  })

  it('keeps the unchecked delete for older clients that omit force', () => {
    const { controller, deleteProjectHostSetup, setupId } = makeController({
      liveTerminals: 3,
      metaIds: ['repo-1::/work/app']
    })

    controller.deleteSetup({ setupId })
    expect(deleteProjectHostSetup).toHaveBeenCalledTimes(1)
  })
})

describe('project removal impact', () => {
  it('counts only this repo and host, and treats unverifiable terminals as live', () => {
    const ptys = [
      { ptyId: 'local-1', worktreeId: 'repo-1::/work/app', connectionId: null },
      { ptyId: 'local-exited', worktreeId: 'repo-1::/work/app', connectionId: null },
      { ptyId: 'ssh-1', worktreeId: 'repo-1::/work/app', connectionId: 'box' },
      { ptyId: 'other-repo', worktreeId: 'repo-10::/work/app', connectionId: null }
    ]
    const isKnownExited = (ptyId: string) => ptyId === 'local-exited'

    expect(countRepoTerminalsNotKnownExited(repo, ptys, isKnownExited)).toBe(1)
    expect(
      countRepoTerminalsNotKnownExited({ ...repo, connectionId: 'box' }, ptys, isKnownExited)
    ).toBe(1)
  })

  it('counts metadata on the repo host only, reading unstamped rows as local', () => {
    const meta = {
      'repo-1::/work/app': {},
      'repo-1::/work/feature': { hostId: 'local' as const },
      'repo-1::/srv/app': { hostId: 'ssh:box' as const },
      'repo-10::/work/app': {}
    }

    expect(countRepoWorkspacesWithMetadata(repo, meta)).toBe(2)
    expect(countRepoWorkspacesWithMetadata({ ...repo, connectionId: 'box' }, meta)).toBe(1)
  })
})
