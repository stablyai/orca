import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WslMoveBlocker } from '../../shared/wsl-move/wsl-move-driver-types'
import {
  wslMoveFenceFromCutovers,
  withWslDriveUncConversions
} from '../persistence/moving-wsl-projects/wsl-move-fence'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import {
  startWslDriveUncConversion,
  type WslDriveUncConversionRunDeps
} from './wsl-drive-unc-conversion-run'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const DRIVE = String.raw`C:\src\app`

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-drive-unc-run-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function state(): PersistedState {
  const value = getDefaultPersistedState('/home/me')
  value.repos = [{ id: 'repo-a', path: UNC, displayName: 'app', badgeColor: '', addedAt: 0 }]
  value.projects = [
    {
      id: 'repo-a',
      displayName: 'app',
      badgeColor: '',
      sourceRepoIds: ['repo-a'],
      createdAt: 0,
      updatedAt: 0
    }
  ]
  return value
}

function deps(overrides: Partial<WslDriveUncConversionRunDeps> = {}): WslDriveUncConversionRunDeps {
  return {
    userDataPath: root,
    profileId: 'profile-1',
    readDriveMounts: async () => [{ mountPoint: '/mnt/c', windowsRoot: 'C:\\' }],
    readProfileState: async () => state(),
    pause: vi.fn(async () => ({ panes: [] })),
    runWindowsGit: vi.fn(async (args: string[]) =>
      args[0] === 'rev-parse' ? '.git\n' : 'git version 2.47'
    ),
    readWorktreeLinks: vi.fn(async () => []),
    restart: vi.fn(),
    newMigrationId: () => 'conv-1',
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    ...overrides
  }
}

const REQUEST = { distro: 'Ubuntu', repoIds: ['repo-a'] }

describe('startWslDriveUncConversion', () => {
  it('pauses the scope, journals the conversion and restarts', async () => {
    const run = deps()
    expect(await startWslDriveUncConversion(run, REQUEST)).toEqual({
      outcome: 'restarting',
      migrationId: 'conv-1'
    })
    // Windows Git checks the same folder through its drive path.
    expect(run.runWindowsGit).toHaveBeenCalledWith(['--version'], DRIVE)
    expect(run.readWorktreeLinks).toHaveBeenCalledWith(String.raw`C:\src\app\.git`)
    expect(run.pause).toHaveBeenCalledWith({
      workspaceIds: [`repo-a::${UNC}`],
      workspaceKeys: new Set([`repo-a::${UNC}`])
    })
    expect(listWslDriveUncConversions(root)).toEqual([
      expect.objectContaining({
        phase: 'prepared',
        profileId: 'profile-1',
        repoIds: ['repo-a'],
        rootPaths: [UNC],
        worktreeIds: [[`repo-a::${UNC}`, `repo-a::${DRIVE}`]]
      })
    ])
    expect(run.restart).toHaveBeenCalledOnce()
  })

  const savedMeta = {
    instanceId: 'saved',
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local' as const
  }
  const ubuntu = String.raw`\\wsl.localhost\Ubuntu\mnt\c`
  it.each([
    { shape: 'inside its folder', parent: UNC, nested: `${UNC}\\nested`, savedWorktree: null },
    { shape: 'at a drive root', parent: ubuntu, nested: `${ubuntu}\\src`, savedWorktree: null },
    {
      shape: 'inside its saved worktree',
      parent: UNC,
      nested: `${ubuntu}\\feature\\nested`,
      savedWorktree: `${ubuntu}\\feature`
    }
  ])(
    'converts a project nested $shape with its parent',
    async ({ parent, nested, savedWorktree }) => {
      const value = state()
      value.repos[0].path = parent
      value.repos.push({ id: 'repo-b', path: nested, displayName: 'b', badgeColor: '', addedAt: 0 })
      value.projects.push({ ...value.projects[0], id: 'repo-b', sourceRepoIds: ['repo-b'] })
      if (savedWorktree) {
        value.worktreeMeta = { [`repo-a::${savedWorktree}`]: savedMeta }
      }
      const run = deps({ readProfileState: async () => value })
      expect(await startWslDriveUncConversion(run, REQUEST)).toMatchObject({
        outcome: 'restarting'
      })
      expect(listWslDriveUncConversions(root)).toEqual([
        expect.objectContaining({ repoIds: ['repo-a', 'repo-b'] })
      ])
    }
  )

  it('refuses, pausing nothing, when the distro does not show /mnt/c as drive C:', async () => {
    for (const mounts of [null, [{ mountPoint: '/mnt/c', windowsRoot: null }]]) {
      const run = deps({ readDriveMounts: async () => mounts })
      expect(await startWslDriveUncConversion(run, REQUEST)).toMatchObject({
        blockers: [{ kind: 'not-convertible', id: 'repo-a', reason: 'not-windows-drive-mount' }]
      })
      expect(run.pause).not.toHaveBeenCalled()
    }
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('converts without Windows touching the UNC path, which WSL refuses for drive folders', async () => {
    const deniedOnUnc = (path: string): void => {
      if (path.startsWith('\\\\')) {
        throw Object.assign(new Error(`EPERM: operation not permitted, '${path}'`), {
          code: 'EPERM'
        })
      }
    }
    const run = deps({
      runWindowsGit: vi.fn(async (args: string[], cwd: string) => {
        deniedOnUnc(cwd)
        return args[0] === 'rev-parse' ? '.git\n' : 'git version 2.47'
      }),
      readWorktreeLinks: vi.fn(async (commonDir: string) => {
        deniedOnUnc(commonDir)
        return []
      })
    })
    expect(await startWslDriveUncConversion(run, REQUEST)).toEqual({
      outcome: 'restarting',
      migrationId: 'conv-1'
    })
  })

  it('converts the seeded shape: a saved UNC worktree beside the drive row discovery wrote', async () => {
    const seeded = (driveName: string): PersistedState => {
      const value = state()
      const savedId = `repo-a::${UNC}`
      const discoveredId = `repo-a::${DRIVE}`
      const row = (instanceId: string, displayName: string) => ({
        instanceId,
        displayName,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 1,
        lastActivityAt: 0,
        hostId: 'local' as const
      })
      value.worktreeMeta = {
        [savedId]: { ...row('saved', 'app'), projectId: 'repo:repo-a' },
        [discoveredId]: row('discovered', driveName)
      }
      value.worktreeIdentityAliases = {
        [`local|${savedId}`]: ['wt2:local:saved'],
        [`local|${discoveredId}`]: ['wt2:local:discovered']
      }
      value.workspaceSession.tabsByWorktree = {
        [savedId]: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: savedId,
            title: 'claude',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
      return value
    }
    const differing = deps({ readProfileState: async () => seeded('renamed on C:') })
    expect(await startWslDriveUncConversion(differing, REQUEST)).toEqual({
      outcome: 'refused',
      blockers: [
        {
          kind: 'state-conflict',
          detail: `wsl_drive_unc_key_collision: repo-a::${DRIVE}`,
          cause: 'differing-saved-data',
          key: `repo-a::${DRIVE}`
        }
      ]
    })
    const run = deps({ readProfileState: async () => seeded('') })
    expect(await startWslDriveUncConversion(run, REQUEST)).toEqual({
      outcome: 'restarting',
      migrationId: 'conv-1'
    })
  })

  it('refuses worktrees WSL Git made, before pausing anything', async () => {
    const run = deps({ readWorktreeLinks: vi.fn(async () => ['/mnt/c/src/feature/.git']) })
    expect(await startWslDriveUncConversion(run, REQUEST)).toEqual({
      outcome: 'refused',
      blockers: [
        { kind: 'wsl-authored-worktrees', repoId: 'repo-a', paths: ['/mnt/c/src/feature'] }
      ]
    })
    expect(run.pause).not.toHaveBeenCalled()
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('refuses a repo the scope does not take, and a missing Git for Windows', async () => {
    const inDistro = deps({
      readProfileState: async () => {
        const value = state()
        value.repos[0].path = String.raw`\\wsl.localhost\Ubuntu\home\me\app`
        return value
      }
    })
    expect(await startWslDriveUncConversion(inDistro, REQUEST)).toEqual({
      outcome: 'refused',
      blockers: [{ kind: 'not-convertible', id: 'repo-a', reason: 'not-in-scope' }]
    })
    const noGit = deps({
      runWindowsGit: vi.fn(async (): Promise<string> => {
        throw new Error('ENOENT')
      })
    })
    expect(await startWslDriveUncConversion(noGit, REQUEST)).toEqual({
      outcome: 'refused',
      blockers: [{ kind: 'windows-git-missing' }]
    })
  })

  it('reports busy terminals and journals nothing', async () => {
    const blockers: WslMoveBlocker[] = [
      { kind: 'agent-working', ids: ['tab-1:leaf-1'], actions: ['wait'] }
    ]
    const run = deps({
      pause: vi.fn(async () => ({
        outcome: 'refused' as const,
        code: 'wsl_move_terminals_blocked' as const,
        blockers
      }))
    })
    expect(await startWslDriveUncConversion(run, REQUEST)).toEqual({
      outcome: 'terminals-blocked',
      blockers
    })
    expect(listWslDriveUncConversions(root)).toEqual([])
    expect(run.restart).not.toHaveBeenCalled()
  })

  it('refuses a second conversion while one waits for its restart', async () => {
    await startWslDriveUncConversion(deps(), REQUEST)
    expect(await startWslDriveUncConversion(deps(), REQUEST)).toEqual({
      outcome: 'refused',
      blockers: [{ kind: 'conversion-pending' }]
    })
  })

  it('lets a new conversion start while an earlier one only has outside stores left to finish', async () => {
    await startWslDriveUncConversion(deps(), REQUEST)
    const [stuck] = listWslDriveUncConversions(root)
    // Past the profile commit, a store that keeps failing must not block every later conversion.
    writeWslDriveUncConversion(root, { ...stuck, phase: 'profile-rewritten' })
    expect(
      await startWslDriveUncConversion(deps({ newMigrationId: () => 'conv-2' }), REQUEST)
    ).toEqual({ outcome: 'restarting', migrationId: 'conv-2' })
  })

  it("lets another profile convert while this profile's conversion waits for its restart", async () => {
    await startWslDriveUncConversion(deps(), REQUEST)
    await startWslDriveUncConversion(
      deps({ profileId: 'profile-2', newMigrationId: () => 'conv-2' }),
      REQUEST
    )
    // The journal lists in directory order, which differs between filesystems.
    expect(
      listWslDriveUncConversions(root)
        .map((record) => record.profileId)
        .sort()
    ).toEqual(['profile-1', 'profile-2'])
  })

  it('fences the projects until the startup rewrite, and not after', async () => {
    await startWslDriveUncConversion(deps(), REQUEST)
    const [record] = listWslDriveUncConversions(root)
    const empty = wslMoveFenceFromCutovers([])
    const fence = withWslDriveUncConversions(empty, [record])
    expect([...fence.fenced.repoIds]).toEqual(['repo-a'])
    expect(fence.fencedRoots).toEqual([
      { distro: 'Ubuntu', roots: ['//wsl.localhost/ubuntu/mnt/c/src/app'] }
    ])
    expect(withWslDriveUncConversions(empty, [{ ...record, phase: 'profile-rewritten' }])).toBe(
      empty
    )
  })
})
