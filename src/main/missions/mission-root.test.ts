import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { existsSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureMissionRoot,
  removeMissionRoot,
  resolveMissionRootPath,
  resolveMissionsBaseDir
} from './mission-root'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mission-root-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

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
  it('suffixes on collision with an existing directory', () => {
    mkdirSync(path.join(tmp, 'referral'), { recursive: true })
    expect(resolveMissionRootPath(tmp, 'Referral')).toBe(path.join(tmp, 'referral-2'))
  })
})

describe('ensureMissionRoot', () => {
  it('creates links, prunes stale ones, repoints wrong targets, keeps files', () => {
    const rootPath = path.join(tmp, 'missions', 'referral')
    const wtA = path.join(tmp, 'wt-a')
    const wtB = path.join(tmp, 'wt-b')
    mkdirSync(wtA, { recursive: true })
    mkdirSync(wtB, { recursive: true })
    mkdirSync(rootPath, { recursive: true })
    // stale link + wrong-target link + a regular file the user created
    symlinkSync(wtB, path.join(rootPath, 'stale'))
    symlinkSync(wtB, path.join(rootPath, 'repo-a'))
    writeFileSync(path.join(rootPath, 'NOTES.md'), 'keep me')

    ensureMissionRoot({
      rootPath,
      links: [
        { name: 'repo-a', targetPath: wtA },
        { name: 'repo-b', targetPath: wtB }
      ]
    })

    expect(readlinkSync(path.join(rootPath, 'repo-a'))).toBe(wtA)
    expect(readlinkSync(path.join(rootPath, 'repo-b'))).toBe(wtB)
    expect(existsSync(path.join(rootPath, 'stale'))).toBe(false)
    expect(existsSync(path.join(rootPath, 'NOTES.md'))).toBe(true)
  })

  it('keeps a live link whose readlink form differs only by a trailing separator', () => {
    // Mirrors Windows junctions, whose targets read back decorated
    // (\\?\ prefix, trailing separator) without pointing anywhere new.
    const rootPath = path.join(tmp, 'missions', 'sync')
    const wtA = path.join(tmp, 'wt-a')
    mkdirSync(wtA, { recursive: true })
    mkdirSync(rootPath, { recursive: true })
    const decoratedTarget = `${wtA}${path.sep}`
    symlinkSync(decoratedTarget, path.join(rootPath, 'repo-a'))

    ensureMissionRoot({ rootPath, links: [{ name: 'repo-a', targetPath: wtA }] })

    // An unlink+recreate would have rewritten the link to the undecorated form.
    expect(readlinkSync(path.join(rootPath, 'repo-a'))).toBe(decoratedTarget)
  })

  it('prunes broken links and skips links whose target is missing', () => {
    const rootPath = path.join(tmp, 'missions', 'qa')
    mkdirSync(rootPath, { recursive: true })
    symlinkSync(path.join(tmp, 'gone'), path.join(rootPath, 'broken'))

    ensureMissionRoot({
      rootPath,
      links: [{ name: 'never-created', targetPath: path.join(tmp, 'also-gone') }]
    })

    expect(lstatSync(rootPath).isDirectory()).toBe(true)
    expect(existsSync(path.join(rootPath, 'broken'))).toBe(false)
    expect(existsSync(path.join(rootPath, 'never-created'))).toBe(false)
  })
})

describe('removeMissionRoot', () => {
  it('removes a root under a missions parent and refuses others', () => {
    const rootPath = path.join(tmp, 'missions', 'referral')
    mkdirSync(rootPath, { recursive: true })
    removeMissionRoot(rootPath)
    expect(existsSync(rootPath)).toBe(false)

    const outside = path.join(tmp, 'not-a-mission')
    mkdirSync(outside, { recursive: true })
    expect(() => removeMissionRoot(outside)).toThrow('mission_root_outside_missions_dir')
    expect(existsSync(outside)).toBe(true)
  })
})
