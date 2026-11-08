import { describe, expect, it } from 'vitest'

import { withDurableRuntimeStore } from '../../orca-runtime-tests/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { Repo } from '../../../../shared/repo-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'

function folder(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id'>
): FolderWorkspace {
  return {
    projectGroupId: 'group-1',
    name: 'Hub',
    folderPath: '/work/hub',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const folderProject: Repo = {
  id: 'repo-folder',
  path: '/work/hub',
  displayName: 'hub project',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'folder'
}

const sshRepo: Repo = {
  id: 'repo-ssh',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  connectionId: 'box'
}

const GROUPS: { id: string; name: string; parentPath: string; connectionId: string | null }[] = [
  { id: 'group-1', name: 'Work', parentPath: '/work', connectionId: null }
]

function createRuntime(folders: FolderWorkspace[], repos: Repo[] = [], groups = GROUPS) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies only the store reads selector resolution makes.
  const store = withDurableRuntimeStore({
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => folders,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}),
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
  return new OrcaRuntimeService(store)
}

const show = (runtime: OrcaRuntimeService, selector: string) =>
  runtime.showManagedWorktree(selector, undefined, { matchFolders: true })

describe('path: and name: selectors on folder workspaces', () => {
  it('match a folder workspace only when the request opts in', async () => {
    const runtime = createRuntime([folder({ id: 'hub-a' })])

    expect((await show(runtime, 'path:/work/hub')).id).toBe('folder:hub-a')
    expect((await show(runtime, 'name:Hub')).id).toBe('folder:hub-a')
    await expect(runtime.showManagedWorktree('path:/work/hub')).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('keeps different folder ids at one path apart, each with its own selector', async () => {
    const runtime = createRuntime([folder({ id: 'hub-a' }), folder({ id: 'hub-b' })])

    await expect(show(runtime, 'path:/work/hub')).rejects.toMatchObject({
      code: 'selector_ambiguous',
      data: {
        candidates: [
          {
            kind: 'folder workspace',
            hostId: 'local',
            path: '/work/hub',
            selector: 'folder:hub-a'
          },
          { kind: 'folder workspace', hostId: 'local', path: '/work/hub', selector: 'folder:hub-b' }
        ]
      }
    })
  })

  it('refuses a folder and a repo-backed row at one path, naming both', async () => {
    const runtime = createRuntime([folder({ id: 'hub-a' })], [folderProject])

    await expect(show(runtime, 'path:/work/hub')).rejects.toMatchObject({
      code: 'selector_ambiguous',
      data: {
        candidates: [
          {
            kind: 'worktree',
            path: '/work/hub',
            selector: expect.stringMatching(/^(id|identity):/)
          },
          { kind: 'folder workspace', path: '/work/hub', selector: 'folder:hub-a' }
        ]
      }
    })
  })

  it('refuses a folder id two folder workspaces share, with each host and path but no selector', async () => {
    const runtime = createRuntime([
      folder({ id: 'hub-a' }),
      folder({ id: 'hub-a', folderPath: '/srv/hub', executionHostId: 'ssh:box' })
    ])

    for (const selector of ['path:/work/hub', 'folder:hub-a']) {
      await expect(show(runtime, selector)).rejects.toMatchObject({
        code: 'selector_ambiguous',
        data: {
          duplicateFolderId: 'hub-a',
          candidates: [
            { hostId: 'local', path: '/work/hub', selector: null },
            { hostId: 'ssh:box', path: '/srv/hub', selector: null }
          ]
        }
      })
    }
  })

  it('refuses a duplicated folder id even when only one copy has a host', async () => {
    const runtime = createRuntime(
      [
        folder({ id: 'hub-a', executionHostId: 'local' }),
        folder({ id: 'hub-a', folderPath: '/srv/hub', projectGroupId: 'group-2' })
      ],
      [],
      [
        ...GROUPS,
        { id: 'group-2', name: 'Mixed', parentPath: '/srv', connectionId: null },
        { id: 'group-2', name: 'Mixed', parentPath: '/srv', connectionId: 'box' }
      ]
    )

    await expect(show(runtime, 'folder:hub-a')).rejects.toMatchObject({
      code: 'selector_ambiguous',
      data: { duplicateFolderId: 'hub-a' }
    })
  })
})

describe('path: on repo-backed rows', () => {
  it('keeps two folder-project sessions at one path apart', async () => {
    const runtime = createRuntime([], [folderProject, { ...folderProject, id: 'repo-folder-2' }])

    await expect(runtime.showManagedWorktree('path:/work/hub')).rejects.toThrow(
      'selector_ambiguous'
    )
  })
})

describe('explicit create parents named by path:', () => {
  it('record a folder parent on a child in another host of the same Orca', async () => {
    const runtime = createRuntime([folder({ id: 'hub-a' })], [sshRepo])

    const resolution = await runtime.resolveLineageForWorktreeCreate(
      { parentWorktree: 'path:/work/hub', matchFolderWorkspaces: true },
      sshRepo
    )

    expect(resolution).toMatchObject({
      kind: 'lineage',
      parent: { type: 'folder', workspaceKey: 'folder:hub-a' }
    })
  })

  it('accept a folder spanning local and SSH repos, which no single host owns', async () => {
    const localRepo: Repo = {
      ...folderProject,
      id: 'repo-local',
      path: '/work/hub/app',
      kind: 'git'
    }
    const remoteRepo: Repo = { ...sshRepo, projectGroupId: 'group-1' }
    const runtime = createRuntime(
      [folder({ id: 'hub-a' })],
      [{ ...localRepo, projectGroupId: 'group-1' }, remoteRepo]
    )

    await expect(show(runtime, 'name:Hub')).rejects.toThrow('selector_ambiguous')
    await expect(
      runtime.resolveLineageForWorktreeCreate(
        { parentWorktree: 'name:Hub', matchFolderWorkspaces: true },
        sshRepo
      )
    ).resolves.toMatchObject({ kind: 'lineage', parent: { workspaceKey: 'folder:hub-a' } })
  })

  it('report an ambiguous parent as ambiguous, not missing', async () => {
    const runtime = createRuntime([folder({ id: 'hub-a' }), folder({ id: 'hub-b' })])

    await expect(
      runtime.resolveLineageForWorktreeCreate({
        parentWorktree: 'path:/work/hub',
        matchFolderWorkspaces: true
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_AMBIGUOUS' })
  })
})
