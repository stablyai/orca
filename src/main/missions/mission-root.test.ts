import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertOwnedMissionRoot,
  ensureMissionRoot,
  removeMissionRoot,
  resolveMissionRootPath,
  resolveMissionsBaseDir,
  type MissionRootLink
} from './mission-root'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mission-root-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function rootFixture(name = 'referral'): {
  baseDir: string
  rootPath: string
  missionId: string
} {
  const baseDir = path.join(tmp, 'missions')
  return { baseDir, rootPath: path.join(baseDir, name), missionId: 'mission-1' }
}

function ensureFixture(
  fixture: ReturnType<typeof rootFixture>,
  links: MissionRootLink[] = []
): void {
  ensureMissionRoot({ ...fixture, links })
}

describe('resolveMissionsBaseDir', () => {
  it('places missions beside an absolute workspaces dir', () => {
    expect(
      resolveMissionsBaseDir(path.join(path.sep, 'home', 'u', 'orca', 'workspaces'), '/home/u')
    ).toBe(path.join(path.sep, 'home', 'u', 'orca', 'missions'))
  })

  it('falls back to the home orca dir for repo-relative settings', () => {
    expect(resolveMissionsBaseDir('.worktrees', path.join(path.sep, 'home', 'u'))).toBe(
      path.join(path.sep, 'home', 'u', 'orca', 'missions')
    )
  })
})

describe('resolveMissionRootPath', () => {
  it('is stable per mission and separates concurrent same-name missions', () => {
    const first = resolveMissionRootPath(tmp, 'Referral', 'mission-1')
    expect(resolveMissionRootPath(tmp, 'Referral', 'mission-1')).toBe(first)
    expect(resolveMissionRootPath(tmp, 'Referral', 'mission-2')).not.toBe(first)
    expect(path.dirname(first)).toBe(tmp)
    expect(path.basename(first)).toMatch(/^referral-[a-f0-9]{12}$/)
  })
})

describe('ensureMissionRoot', () => {
  it('proves only an existing marker-owned non-link root', () => {
    const fixture = rootFixture('owned')
    ensureFixture(fixture)

    expect(() => assertOwnedMissionRoot(fixture)).not.toThrow()
    expect(() => assertOwnedMissionRoot({ ...fixture, missionId: 'another-mission' })).toThrow(
      'mission_root_owned_by_another_mission'
    )
  })

  it('projects two independent worktrees into one readable and writable root', () => {
    const fixture = rootFixture('cross-repo')
    const originalA = path.join(tmp, 'original-a')
    const originalB = path.join(tmp, 'original-b')
    const worktreeA = path.join(tmp, 'worktree-a')
    const worktreeB = path.join(tmp, 'worktree-b')
    for (const directory of [originalA, originalB, worktreeA, worktreeB]) {
      mkdirSync(directory)
      writeFileSync(path.join(directory, 'state.txt'), path.basename(directory))
    }

    ensureFixture(fixture, [
      { name: 'repo-a', targetPath: worktreeA },
      { name: 'repo-b', targetPath: worktreeB }
    ])
    writeFileSync(path.join(fixture.rootPath, 'repo-a', 'state.txt'), 'changed-a')
    writeFileSync(path.join(fixture.rootPath, 'repo-b', 'state.txt'), 'changed-b')

    expect(readFileSync(path.join(worktreeA, 'state.txt'), 'utf8')).toBe('changed-a')
    expect(readFileSync(path.join(worktreeB, 'state.txt'), 'utf8')).toBe('changed-b')
    expect(readFileSync(path.join(originalA, 'state.txt'), 'utf8')).toBe('original-a')
    expect(readFileSync(path.join(originalB, 'state.txt'), 'utf8')).toBe('original-b')
  })

  it('syncs managed links while preserving files and untracked links', () => {
    const fixture = rootFixture()
    const wtA = path.join(tmp, 'wt-a')
    const wtB = path.join(tmp, 'wt-b')
    const userTarget = path.join(tmp, 'user-target')
    mkdirSync(wtA)
    mkdirSync(wtB)
    mkdirSync(userTarget)

    ensureFixture(fixture, [
      { name: 'stale', targetPath: wtB },
      { name: 'repo-a', targetPath: wtB }
    ])
    writeFileSync(path.join(fixture.rootPath, 'NOTES.md'), 'keep me')
    symlinkSync(userTarget, path.join(fixture.rootPath, 'user-link'))

    ensureFixture(fixture, [
      { name: 'repo-a', targetPath: wtA },
      { name: 'repo-b', targetPath: wtB }
    ])

    expect(readlinkSync(path.join(fixture.rootPath, 'repo-a'))).toBe(wtA)
    expect(readlinkSync(path.join(fixture.rootPath, 'repo-b'))).toBe(wtB)
    expect(existsSync(path.join(fixture.rootPath, 'stale'))).toBe(false)
    expect(readlinkSync(path.join(fixture.rootPath, 'user-link'))).toBe(userTarget)
    expect(existsSync(path.join(fixture.rootPath, 'NOTES.md'))).toBe(true)
  })

  it('keeps a live link whose readlink form differs only by a trailing separator', () => {
    const fixture = rootFixture('sync')
    const wtA = path.join(tmp, 'wt-a')
    mkdirSync(wtA)
    ensureFixture(fixture, [{ name: 'repo-a', targetPath: wtA }])
    unlinkSync(path.join(fixture.rootPath, 'repo-a'))
    const decoratedTarget = `${wtA}${path.sep}`
    symlinkSync(decoratedTarget, path.join(fixture.rootPath, 'repo-a'))

    ensureFixture(fixture, [{ name: 'repo-a', targetPath: wtA }])

    // An unlink+recreate would have rewritten the link to the undecorated form.
    expect(readlinkSync(path.join(fixture.rootPath, 'repo-a'))).toBe(decoratedTarget)
  })

  it('prunes a broken managed link and skips a missing target', () => {
    const fixture = rootFixture('qa')
    const target = path.join(tmp, 'target')
    mkdirSync(target)
    ensureFixture(fixture, [{ name: 'broken', targetPath: target }])
    rmSync(target, { recursive: true })

    ensureFixture(fixture, [
      { name: 'broken', targetPath: target },
      { name: 'never-created', targetPath: path.join(tmp, 'also-gone') }
    ])

    expect(lstatSync(fixture.rootPath).isDirectory()).toBe(true)
    expect(lstatSync(path.join(fixture.rootPath, '.orca-mission-root.json')).isFile()).toBe(true)
    expect(existsSync(path.join(fixture.rootPath, 'broken'))).toBe(false)
    expect(existsSync(path.join(fixture.rootPath, 'never-created'))).toBe(false)
  })

  it('rejects roots outside the trusted base, including a lookalike missions parent', () => {
    const fixture = rootFixture()
    const lookalikeRoot = path.join(tmp, 'attacker', 'missions', 'victim')
    mkdirSync(lookalikeRoot, { recursive: true })
    writeFileSync(path.join(lookalikeRoot, 'keep.txt'), 'keep')

    expect(() => ensureMissionRoot({ ...fixture, rootPath: lookalikeRoot, links: [] })).toThrow(
      'mission_root_outside_trusted_base'
    )
    expect(existsSync(path.join(lookalikeRoot, 'keep.txt'))).toBe(true)
  })

  it('rejects nested roots instead of widening the trusted base recursively', () => {
    const fixture = rootFixture()
    const nestedRoot = path.join(fixture.baseDir, 'nested', 'root')

    expect(() => ensureMissionRoot({ ...fixture, rootPath: nestedRoot, links: [] })).toThrow(
      'mission_root_outside_trusted_base'
    )
    expect(existsSync(nestedRoot)).toBe(false)
  })

  it('rejects non-normalized persistence paths before symlink traversal', () => {
    const fixture = rootFixture()
    const outside = path.join(tmp, 'outside')
    mkdirSync(fixture.baseDir)
    mkdirSync(outside)
    symlinkSync(outside, path.join(fixture.baseDir, 'escape'))
    const traversingRoot = `${fixture.baseDir}${path.sep}escape${path.sep}..${path.sep}victim`

    expect(() => ensureMissionRoot({ ...fixture, rootPath: traversingRoot, links: [] })).toThrow(
      'mission_root_outside_trusted_base'
    )
  })

  it('rejects a symlink root without touching its target', () => {
    const fixture = rootFixture()
    const target = path.join(tmp, 'target')
    mkdirSync(fixture.baseDir)
    mkdirSync(target)
    writeFileSync(path.join(target, 'keep.txt'), 'keep')
    symlinkSync(target, fixture.rootPath)

    expect(() => ensureFixture(fixture)).toThrow('mission_root_is_link')
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true)
  })

  it('refuses to claim a non-empty root without an ownership marker', () => {
    const fixture = rootFixture()
    mkdirSync(fixture.rootPath, { recursive: true })
    writeFileSync(path.join(fixture.rootPath, 'NOTES.md'), 'keep')

    expect(() => ensureFixture(fixture)).toThrow('mission_root_unowned')
    expect(existsSync(path.join(fixture.rootPath, 'NOTES.md'))).toBe(true)
  })

  it('rejects a root marker owned by a different mission', () => {
    const fixture = rootFixture()
    ensureFixture(fixture)

    expect(() => ensureMissionRoot({ ...fixture, missionId: 'mission-2', links: [] })).toThrow(
      'mission_root_owned_by_another_mission'
    )
  })

  it('preserves regular-file and untracked-link name conflicts', () => {
    const fixture = rootFixture()
    const target = path.join(tmp, 'target')
    const otherTarget = path.join(tmp, 'other-target')
    mkdirSync(target)
    mkdirSync(otherTarget)
    ensureFixture(fixture)
    writeFileSync(path.join(fixture.rootPath, 'repo-file'), 'keep')
    symlinkSync(otherTarget, path.join(fixture.rootPath, 'repo-link'))

    expect(() => ensureFixture(fixture, [{ name: 'repo-file', targetPath: target }])).toThrow(
      'mission_root_link_name_conflict:repo-file'
    )
    expect(() => ensureFixture(fixture, [{ name: 'repo-link', targetPath: target }])).toThrow(
      'mission_root_link_name_conflict:repo-link'
    )
    expect(existsSync(path.join(fixture.rootPath, 'repo-file'))).toBe(true)
    expect(readlinkSync(path.join(fixture.rootPath, 'repo-link'))).toBe(otherTarget)
  })
})

describe('removeMissionRoot', () => {
  it('removes an empty owned root after cleaning its managed links', () => {
    const fixture = rootFixture()
    const target = path.join(tmp, 'target')
    mkdirSync(target)
    ensureFixture(fixture, [{ name: 'repo', targetPath: target }])

    expect(removeMissionRoot(fixture)).toEqual({ removed: true, preservedEntries: [] })
    expect(existsSync(fixture.rootPath)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('preserves regular files and untracked links in a non-empty root', () => {
    const fixture = rootFixture()
    const target = path.join(tmp, 'target')
    const userTarget = path.join(tmp, 'user-target')
    mkdirSync(target)
    mkdirSync(userTarget)
    ensureFixture(fixture, [{ name: 'repo', targetPath: target }])
    writeFileSync(path.join(fixture.rootPath, 'NOTES.md'), 'keep')
    symlinkSync(userTarget, path.join(fixture.rootPath, 'user-link'))

    expect(removeMissionRoot(fixture)).toEqual({
      removed: false,
      preservedEntries: ['NOTES.md', 'user-link']
    })
    expect(existsSync(path.join(fixture.rootPath, 'repo'))).toBe(false)
    expect(existsSync(path.join(fixture.rootPath, '.orca-mission-root.json'))).toBe(true)
    expect(
      JSON.parse(readFileSync(path.join(fixture.rootPath, '.orca-mission-root.json'), 'utf8'))
    ).toMatchObject({ missionId: fixture.missionId, links: [] })
    expect(existsSync(path.join(fixture.rootPath, 'NOTES.md'))).toBe(true)
    expect(readlinkSync(path.join(fixture.rootPath, 'user-link'))).toBe(userTarget)
  })

  it('preserves a managed link whose target was replaced externally', () => {
    const fixture = rootFixture()
    const managedTarget = path.join(tmp, 'managed-target')
    const replacementTarget = path.join(tmp, 'replacement-target')
    mkdirSync(managedTarget)
    mkdirSync(replacementTarget)
    ensureFixture(fixture, [{ name: 'repo', targetPath: managedTarget }])
    unlinkSync(path.join(fixture.rootPath, 'repo'))
    symlinkSync(replacementTarget, path.join(fixture.rootPath, 'repo'))

    expect(removeMissionRoot(fixture)).toEqual({
      removed: false,
      preservedEntries: ['repo']
    })
    expect(readlinkSync(path.join(fixture.rootPath, 'repo'))).toBe(replacementTarget)
  })

  it('refuses a corrupted lookalike path and leaves all contents intact', () => {
    const fixture = rootFixture()
    const outside = path.join(tmp, 'elsewhere', 'missions', 'victim')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'keep.txt'), 'keep')

    expect(() => removeMissionRoot({ ...fixture, rootPath: outside })).toThrow(
      'mission_root_outside_trusted_base'
    )
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('refuses an unowned root and a symlink root', () => {
    const fixture = rootFixture()
    mkdirSync(fixture.rootPath, { recursive: true })
    writeFileSync(path.join(fixture.rootPath, 'keep.txt'), 'keep')
    expect(() => removeMissionRoot(fixture)).toThrow('mission_root_unowned')

    rmSync(fixture.rootPath, { recursive: true })
    const target = path.join(tmp, 'target')
    mkdirSync(target)
    symlinkSync(target, fixture.rootPath)
    expect(() => removeMissionRoot(fixture)).toThrow('mission_root_is_link')
    expect(existsSync(target)).toBe(true)
  })
})
