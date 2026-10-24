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
import { listWslDriveUncConversions } from './wsl-drive-unc-conversion-journal'
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
        repoIds: ['repo-a'],
        rootPaths: [UNC],
        worktreeIds: [[`repo-a::${UNC}`, `repo-a::${DRIVE}`]]
      })
    ])
    expect(run.restart).toHaveBeenCalledOnce()
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
