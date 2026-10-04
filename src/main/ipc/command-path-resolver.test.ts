import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCommandOnLocalPath, listLocalCommandPaths } from './command-path-resolver'

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

  // Why the full list exists (#22975): a dead version-manager shim passes the
  // same executable check as the binary it shadows, so a winner-only lookup can
  // only ever hand the caller the shim. The copies behind it are the answer.
  describe.skipIf(process.platform === 'win32')('listLocalCommandPaths', () => {
    let front = ''
    let middle = ''
    let back = ''

    async function executable(dir: string, name: string, body: string): Promise<void> {
      await writeFile(path.join(dir, name), body)
      await chmod(path.join(dir, name), 0o755)
    }

    beforeAll(async () => {
      front = await mkdtemp(path.join(tmpdir(), 'cmd-list-front-'))
      middle = await mkdtemp(path.join(tmpdir(), 'cmd-list-middle-'))
      back = await mkdtemp(path.join(tmpdir(), 'cmd-list-back-'))
      await executable(front, 'gh', '#!/usr/bin/env bash\nexec /nope/asdf exec "gh" "$@"\n')
      await executable(back, 'gh', "#!/bin/sh\nprintf 'gh version 2.98.0\\n'\n")
      // Both a non-executable file and a directory in the middle: neither is a
      // match, and neither may end the scan.
      await writeFile(path.join(middle, 'gh'), 'not executable\n')
      await chmod(path.join(middle, 'gh'), 0o644)
      await mkdir(path.join(middle, 'glab'))
      await executable(back, 'glab', '#!/bin/sh\n')
    })

    afterAll(async () => {
      await rm(front, { recursive: true, force: true })
      await rm(middle, { recursive: true, force: true })
      await rm(back, { recursive: true, force: true })
    })

    it('returns every match in PATH order, shim first', async () => {
      await expect(
        listLocalCommandPaths('gh', {
          platform: 'linux',
          env: { PATH: `${front}:${middle}:${back}` }
        })
      ).resolves.toEqual([path.posix.join(front, 'gh'), path.posix.join(back, 'gh')])
    })

    it('follows PATH order rather than which copy runs', async () => {
      await expect(
        listLocalCommandPaths('gh', { platform: 'linux', env: { PATH: `${back}:${front}` } })
      ).resolves.toEqual([path.posix.join(back, 'gh'), path.posix.join(front, 'gh')])
    })

    it('skips a directory that matches the command name and keeps scanning', async () => {
      await expect(
        listLocalCommandPaths('glab', {
          platform: 'linux',
          env: { PATH: `${middle}:${front}:${back}` }
        })
      ).resolves.toEqual([path.posix.join(back, 'glab')])
    })

    it('returns an empty list when PATH holds no absolute match', async () => {
      await expect(
        listLocalCommandPaths('gh', { platform: 'linux', env: { PATH: '' } })
      ).resolves.toEqual([])
    })

    it('applies the absolute-only gate to the whole list, not just the winner', async () => {
      await expect(
        listLocalCommandPaths('gh', {
          platform: 'linux',
          env: { PATH: `.${path.delimiter}${front}` }
        })
      ).resolves.toEqual([path.posix.join(front, 'gh')])
    })

    it('drops a relative match the filesystem would otherwise find', async () => {
      // Why a second relative case: `path.posix.join('.', 'gh')` collapses to
      // `gh`, so the case above is unaffected by deleting the gate. `fs.access`
      // resolves a relative candidate against the process cwd, so only a PATH
      // entry that really reaches a fixture proves the filter — and the `access`
      // proves that reach first, making this fail loudly instead of going
      // vacuous if the suite is ever run from a directory that hides it.
      const relative = path.relative(process.cwd(), back)
      await expect(access(path.join(relative, 'gh'))).resolves.toBeUndefined()
      await expect(
        listLocalCommandPaths('gh', { platform: 'linux', env: { PATH: relative } })
      ).resolves.toEqual([])
    })

    it('lists a PATH entry that repeats only once', async () => {
      // Why it matters: callers spawn each entry, and `/usr/local/bin` appearing
      // twice in a real PATH is normal — a doomed shim must not be probed twice.
      await expect(
        listLocalCommandPaths('gh', {
          platform: 'linux',
          env: { PATH: `${back}:${front}:${back}` }
        })
      ).resolves.toEqual([path.posix.join(back, 'gh'), path.posix.join(front, 'gh')])
    })

    it('returns an empty list for an empty command', async () => {
      await expect(listLocalCommandPaths('')).resolves.toEqual([])
    })

    it('resolves an absolute command path directly', async () => {
      await expect(
        listLocalCommandPaths(path.join(front, 'gh'), { platform: 'linux', env: { PATH: '' } })
      ).resolves.toEqual([`${front}/gh`])
    })

    it('lists every PATHEXT permutation on win32, in resolver order', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'cmd-list-win32-'))
      try {
        await writeFile(path.join(dir, 'tool.CMD'), '@echo off\n')
        await writeFile(path.join(dir, 'tool.EXE'), '')
        await expect(
          listLocalCommandPaths('tool', {
            platform: 'win32',
            env: { Path: dir, PATHEXT: '.CMD;.EXE' },
            cwd: dir
          })
        ).resolves.toEqual([`${dir}/tool.CMD`, `${dir}/tool.EXE`])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
