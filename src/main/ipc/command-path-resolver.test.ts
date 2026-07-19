import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCommandOnLocalPath } from './command-path-resolver'

describe('isCommandOnLocalPath', () => {
  it('returns false for an empty command', async () => {
    await expect(isCommandOnLocalPath('')).resolves.toBe(false)
  })

  // POSIX semantics: executable bit + absolute-only + symlink follow.
  describe.skipIf(process.platform === 'win32')('posix', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'cmd-resolver-posix-'))
      await writeFile(path.join(dir, 'runme'), '#!/bin/sh\n')
      await chmod(path.join(dir, 'runme'), 0o755)
      await writeFile(path.join(dir, 'plain'), 'not executable\n')
      await chmod(path.join(dir, 'plain'), 0o644)
      await mkdir(path.join(dir, 'adir'))
      await symlink(path.join(dir, 'runme'), path.join(dir, 'linkme'))
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('finds an executable file on PATH', async () => {
      await expect(
        isCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(true)
    })

    it('rejects a non-executable file on PATH', async () => {
      await expect(
        isCommandOnLocalPath('plain', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(false)
    })

    it('rejects a directory whose name matches the command', async () => {
      await expect(
        isCommandOnLocalPath('adir', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(false)
    })

    it('follows a symlink to an executable', async () => {
      await expect(
        isCommandOnLocalPath('linkme', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(true)
    })

    it('returns false when PATH is empty', async () => {
      await expect(
        isCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: '' } })
      ).resolves.toBe(false)
    })

    it('resolves an absolute command path directly', async () => {
      await expect(
        isCommandOnLocalPath(path.join(dir, 'runme'), { platform: 'linux', env: { PATH: '' } })
      ).resolves.toBe(true)
    })

    it('rejects a match reached via a relative PATH entry (absolute-only gate)', async () => {
      await expect(
        isCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: '.' }, cwd: dir })
      ).resolves.toBe(false)
    })
  })

  // Win32 semantics tested cross-platform via the explicit `platform` option:
  // PATHEXT resolution + case-insensitive `Path` key.
  describe('win32 (synthetic)', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'cmd-resolver-win32-'))
      // Why: the fixture extension matches a PATHEXT entry's case exactly so these
      // tests are filesystem-portable. Real Windows resolves `.CMD` vs `.cmd`
      // case-insensitively via the FS itself (same as where.exe); we deliberately
      // do NOT emulate that in the resolver, so we must not depend on a
      // case-insensitive FS here — this suite also runs on case-sensitive Linux CI.
      await writeFile(path.join(dir, 'tool.CMD'), '@echo off\n')
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('resolves a bare command via PATHEXT using the case-insensitive Path key', async () => {
      await expect(
        isCommandOnLocalPath('tool', {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.COM;.EXE;.CMD;.BAT' }
        })
      ).resolves.toBe(true)
    })

    it('returns false when PATHEXT excludes the only available extension', async () => {
      await expect(
        isCommandOnLocalPath('tool', {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.EXE;.COM' }
        })
      ).resolves.toBe(false)
    })

    it('matches an exact name with extension already present', async () => {
      await expect(
        isCommandOnLocalPath('tool.CMD', {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.EXE' }
        })
      ).resolves.toBe(true)
    })
  })
})
