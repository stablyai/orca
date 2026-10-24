import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWindowsRuntimePreference } from '../../shared/project-execution-runtime'
import {
  applyNewWindowsDriveProjectDefault,
  newWindowsDriveProjectRuntimePreference,
  readMainCheckoutWorktreeLinks,
  type NewWindowsDriveProjectDefaultArgs
} from './wsl-drive-project-new-default'

const gate = vi.hoisted(() => ({ open: true }))
vi.mock('./wsl-host-gate', () => ({ wslHostsGateOpen: () => gate.open }))

const WSL_DEFAULT = { kind: 'wsl', distro: 'Ubuntu' }

function args(overrides: Partial<NewWindowsDriveProjectDefaultArgs> = {}) {
  return {
    platform: 'win32',
    repo: { path: 'C:\\src\\app', kind: 'git' as const },
    globalWindowsRuntimeDefault: WSL_DEFAULT,
    readWorktreeLinks: () => [],
    ...overrides
  }
}

describe('newWindowsDriveProjectRuntimePreference', () => {
  it('pins the global distro with Git for Windows for a drive project', () => {
    expect(newWindowsDriveProjectRuntimePreference(args())).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      git: 'windows-host'
    })
  })

  it.each([
    ['off Windows', { platform: 'darwin' }],
    ['under a Windows default', { globalWindowsRuntimeDefault: { kind: 'windows-host' } }],
    ['with no default distro', { globalWindowsRuntimeDefault: { kind: 'wsl', distro: null } }],
    ['inside a distro', { repo: { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' } }],
    ['for a folder project', { repo: { path: 'C:\\src\\app', kind: 'folder' as const } }],
    ['on another host', { repo: { path: 'C:\\src\\app', executionHostId: 'ssh:box' as const } }],
    ['with WSL-authored worktrees', { readWorktreeLinks: () => ['/mnt/c/src/feature/.git'] }],
    ['when its worktree links are unreadable', { readWorktreeLinks: () => null }]
  ])('leaves the project inheriting %s', (_name, overrides) => {
    expect(newWindowsDriveProjectRuntimePreference(args(overrides))).toBeNull()
  })

  it('accepts worktrees Windows Git made', () => {
    expect(
      newWindowsDriveProjectRuntimePreference(
        args({ readWorktreeLinks: () => ['C:/src/feature/.git'] })
      )
    ).not.toBeNull()
  })
})

describe('applyNewWindowsDriveProjectDefault', () => {
  beforeEach(() => {
    gate.open = true
  })

  function state(localWindowsRuntimePreference?: LocalWindowsRuntimePreference) {
    return {
      projects: [{ sourceRepoIds: ['r1'], localWindowsRuntimePreference }],
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
      }
    }
  }
  const repo = { id: 'r1', path: 'C:\\src\\app', kind: 'git' as const }
  const env = { platform: 'win32', readWorktreeLinks: () => [] }

  it("writes the default onto the repo's new project", () => {
    const current = state()
    expect(applyNewWindowsDriveProjectDefault(current, repo, env)).toBe(true)
    expect(current.projects[0].localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      git: 'windows-host'
    })
  })

  it('keeps a preference the project already has', () => {
    const current = state({ kind: 'windows-host' })
    expect(applyNewWindowsDriveProjectDefault(current, repo, env)).toBe(false)
    expect(current.projects[0].localWindowsRuntimePreference).toEqual({
      kind: 'windows-host'
    })
  })

  it('does nothing while the WSL hosts gate is closed', () => {
    gate.open = false
    const current = state()
    expect(applyNewWindowsDriveProjectDefault(current, repo, env)).toBe(false)
    expect(current.projects[0].localWindowsRuntimePreference).toBeUndefined()
  })
})

describe('readMainCheckoutWorktreeLinks', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-drive-default-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads each linked worktree's gitdir link", () => {
    mkdirSync(join(dir, '.git', 'worktrees', 'feature'), { recursive: true })
    writeFileSync(join(dir, '.git', 'worktrees', 'feature', 'gitdir'), '/mnt/c/src/feature/.git\n')
    expect(readMainCheckoutWorktreeLinks(dir)).toEqual(['/mnt/c/src/feature/.git'])
  })

  it('reads a checkout with no linked worktrees as none', () => {
    mkdirSync(join(dir, '.git'))
    expect(readMainCheckoutWorktreeLinks(dir)).toEqual([])
  })

  it('reads a linked worktree or missing checkout as unknown', () => {
    expect(readMainCheckoutWorktreeLinks(dir)).toBeNull()
    writeFileSync(join(dir, '.git'), 'gitdir: C:/src/app/.git/worktrees/x\n')
    expect(readMainCheckoutWorktreeLinks(dir)).toBeNull()
  })
})
