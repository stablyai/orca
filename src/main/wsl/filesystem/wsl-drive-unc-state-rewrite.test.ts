import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import '../../persistence/__fixtures__/wsl-mover/wsl-mover-folders-profile'
import { heavyWslMoverProfile } from '../../persistence/__fixtures__/wsl-mover/wsl-mover-heavy-profile'
import {
  repo,
  terminalTab,
  WSL_MOVER_DISTRO,
  type WslMoverPaths
} from '../../persistence/__fixtures__/wsl-mover/wsl-mover-profile-rows'
import type { WslMoveProjectionInput } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-state-projection'
import { WslDriveUncKeyCollisionError } from './wsl-drive-unc-identity-rewrite'
import { rewriteWslDriveUncState } from './wsl-drive-unc-state-rewrite'

// Each fixture's Linux paths, put under the C: drive: as the distro sees it, then as Windows does.
const unc: WslMoverPaths = {
  side: 'source',
  at: (linuxPath, spelling = 'wsl.localhost') =>
    `\\\\${spelling}\\${WSL_MOVER_DISTRO}\\mnt\\c${linuxPath.replaceAll('/', '\\')}`,
  fileUrl: (linuxPath) => `file://wsl.localhost/${WSL_MOVER_DISTRO}/mnt/c${linuxPath}`
}
const drive: WslMoverPaths = {
  side: 'source',
  at: (linuxPath) => `C:${linuxPath.replaceAll('/', '\\')}`,
  fileUrl: (linuxPath) => `file:///C:${linuxPath}`
}

function persisted(input: WslMoveProjectionInput): PersistedState {
  return {
    ...getDefaultPersistedState('/home/me'),
    ...input.state,
    workspaceSession: Object.assign(
      getDefaultPersistedState('/home/me').workspaceSession,
      input.session
    ),
    ui: { ...getDefaultPersistedState('/home/me').ui, ...input.ui }
  }
}

function convert(state: PersistedState, repoIds: string[], folderWorkspaceIds: string[] = []) {
  return rewriteWslDriveUncState(state, { distro: WSL_MOVER_DISTRO, repoIds, folderWorkspaceIds })
}

describe('rewriteWslDriveUncState', () => {
  it('rewrites minted PTY session ids, keeping the incarnation suffix', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    const oldId = `repo-a::${unc.at('/home/dev/app')}`
    const minted = `${oldId}@@4f1c`
    before.workspaceSession.tabsByWorktree[oldId] = [terminalTab('tab-1', oldId, null, minted)]
    before.workspaceSession.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-1': minted }
    }
    const { state } = convert(before, ['repo-a', 'repo-b'])
    const newId = `repo-a::${drive.at('/home/dev/app')}`
    expect(state.workspaceSession.tabsByWorktree[newId]?.[0]?.ptyId).toBe(`${newId}@@4f1c`)
    expect(state.workspaceSession.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      'leaf-1': `${newId}@@4f1c`
    })
  })

  it('leaves projects outside the scope, other hosts and user text as written', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    const otherId = `repo-b::${unc.at('/home/dev/lib', 'wsl$')}`
    before.workspaceSessionsByHostId = {
      'ssh:box': { ...before.workspaceSession }
    }
    before.settings = { ...before.settings, workspaceDir: unc.at('/home/dev/app') }
    const { state } = convert(before, ['repo-a'])
    expect(state.repos.find((row) => row.id === 'repo-b')).toEqual(
      before.repos.find((row) => row.id === 'repo-b')
    )
    expect(state.workspaceSession.tabsByWorktree[otherId]).toEqual(
      before.workspaceSession.tabsByWorktree[otherId]
    )
    expect(state.workspaceSessionsByHostId).toBe(before.workspaceSessionsByHostId)
    expect(state.settings).toBe(before.settings)
    expect(state.projects.find((row) => row.id === 'project-b')).toEqual(
      before.projects.find((row) => row.id === 'project-b')
    )
  })

  it('is idempotent, so a resumed conversion changes nothing', () => {
    const once = convert(persisted(heavyWslMoverProfile(unc)), ['repo-a', 'repo-b']).state
    const twice = convert(once, ['repo-a', 'repo-b'])
    expect(twice.state).toEqual(once)
    expect(twice.worktreeIds.size).toBe(0)
  })

  it('refuses a project that would keep an unconverted repo', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    before.projects = [{ ...before.projects[0], sourceRepoIds: ['repo-a', 'repo-b'] }]
    expect(() => convert(before, ['repo-a'])).toThrow('wsl_drive_unc_project_split')
  })

  it('refuses when a converted key lands on one with different user data, naming the key', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    const oldId = `repo-a::${unc.at('/home/dev/app')}`
    const newId = `repo-a::${drive.at('/home/dev/app')}`
    before.worktreeMeta[newId] = { ...before.worktreeMeta[oldId], displayName: 'other' }
    expect(() => convert(before, ['repo-a', 'repo-b'])).toThrow(
      new WslDriveUncKeyCollisionError(newId)
    )
  })

  it('merges a drive key that holds nothing, or the same data, into the converted one', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    const oldId = `repo-a::${unc.at('/home/dev/app')}`
    const newId = `repo-a::${drive.at('/home/dev/app')}`
    before.workspaceSession.tabsByWorktree[newId] = []
    before.worktreeMeta[newId] = before.worktreeMeta[oldId]
    const { state } = convert(before, ['repo-a', 'repo-b'])
    expect(state.workspaceSession.tabsByWorktree[newId]).toEqual(
      convert(persisted(heavyWslMoverProfile(unc)), ['repo-a', 'repo-b']).state.workspaceSession
        .tabsByWorktree[newId]
    )
    expect(state.worktreeMeta[newId]?.displayName).toBe('app')
  })

  it('drops the drive-keyed row startup discovery wrote for the saved UNC worktree', () => {
    // Seeded shape: WSL Git lists the UNC project's folder as C:\, so discovery wrote a bare row.
    const before = persisted(heavyWslMoverProfile(unc))
    const oldId = `repo-a::${unc.at('/home/dev/app')}`
    const newId = `repo-a::${drive.at('/home/dev/app')}`
    before.worktreeMeta[oldId] = { ...before.worktreeMeta[oldId], instanceId: 'saved' }
    before.worktreeMeta[newId] = {
      instanceId: 'discovered',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 2,
      lastActivityAt: 0,
      workspaceStatus: 'in-progress',
      hostId: 'local'
    }
    before.worktreeIdentityAliases = {
      [`local|${oldId}`]: ['wt2:local:saved'],
      [`local|${newId}`]: ['wt2:local:discovered']
    }
    before.worktreeMetaByIdentity = { 'wt2:local:discovered': before.worktreeMeta[newId] }
    const { state } = convert(before, ['repo-a', 'repo-b'])
    expect(state.worktreeMeta[newId]).toMatchObject({
      instanceId: 'saved',
      displayName: 'app',
      priorWorktreeIds: [oldId]
    })
    expect(state.worktreeMeta[oldId]).toBeUndefined()
    expect(state.worktreeIdentityAliases).toEqual({ [`local|${newId}`]: ['wt2:local:saved'] })
    expect(state.worktreeMetaByIdentity).toEqual({})
    expect(state.workspaceSession.tabsByWorktree[newId]).toEqual([
      expect.objectContaining({ id: 'tab-1', worktreeId: newId })
    ])
  })

  it('keeps a drive-keyed row whose status the user chose, refusing instead of dropping it', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    const oldId = `repo-a::${unc.at('/home/dev/app')}`
    const newId = `repo-a::${drive.at('/home/dev/app')}`
    before.worktreeMeta[newId] = {
      instanceId: 'discovered',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 2,
      lastActivityAt: 0,
      // Discovery writes the default; 'done' is something the user set.
      workspaceStatus: 'done',
      hostId: 'local'
    }
    expect(before.worktreeMeta[oldId]).toBeDefined()
    expect(() => convert(before, ['repo-a', 'repo-b'])).toThrow(
      new WslDriveUncKeyCollisionError(newId)
    )
  })

  it('maps a bare path only inside a converted folder', () => {
    const before = persisted(heavyWslMoverProfile(unc))
    before.repos = [...before.repos, repo('repo-c', unc.at('/home/dev/other'))]
    before.ui = {
      ...before.ui,
      explorerDisplayRootByWorktree: {
        [`repo-a::${unc.at('/home/dev/app')}`]: unc.at('/home/dev/app/src'),
        [`repo-c::${unc.at('/home/dev/other')}`]: unc.at('/home/dev/other/src')
      }
    }
    const { state } = convert(before, ['repo-a', 'repo-b'])
    expect(state.ui.explorerDisplayRootByWorktree).toEqual({
      [`repo-a::${drive.at('/home/dev/app')}`]: drive.at('/home/dev/app/src'),
      [`repo-c::${unc.at('/home/dev/other')}`]: unc.at('/home/dev/other/src')
    })
  })
})
