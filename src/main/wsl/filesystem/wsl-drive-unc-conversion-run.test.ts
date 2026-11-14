import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'

import '../../persistence/moving-wsl-projects/quiescence/wsl-move-fence'
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
})
