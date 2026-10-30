import { access, chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Exercise Windows filename folding through source listings on case-sensitive hosts.
vi.mock('./command-path-directory-worker-client', async () => ({
  readDetectionDirectoryViaWorker: vi.fn(
    (await import('./command-path-directory')).readDetectionDirectory
  )
}))

import { readDetectionDirectoryViaWorker } from './command-path-directory-worker-client'
import {
  findCommandsOnLocalPath,
  isCommandOnLocalPath,
  listLocalCommandPaths
} from './command-path-resolver'

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
      // Match PATHEXT case in fixtures; real Windows handles filename case while Linux test filesystems do not.
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

  // Executable-but-broken shims can shadow working binaries; retain later PATH candidates (#22975).
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
      // Ensure this relative PATH entry actually reaches a fixture before asserting the absolute-only filter.
      const relative = path.relative(process.cwd(), back)
      await expect(access(path.join(relative, 'gh'))).resolves.toBeUndefined()
      await expect(
        listLocalCommandPaths('gh', { platform: 'linux', env: { PATH: relative } })
      ).resolves.toEqual([])
    })

    it('lists a PATH entry that repeats only once', async () => {
      // Duplicate PATH directories must not probe doomed shims repeatedly.
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
        await writeFile(path.join(dir, 'tool'), '')
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

describe('findCommandsOnLocalPath', () => {
  // POSIX semantics must match the per-candidate lookup.
  describe.skipIf(process.platform === 'win32')('posix', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'cmd-batch-posix-'))
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

    it('returns only executable commands, with the same verdict as isCommandOnLocalPath', async () => {
      const commands = ['runme', 'plain', 'adir', 'linkme', 'missing']
      const options = { platform: 'linux' as const, env: { PATH: dir } }
      const batch = await findCommandsOnLocalPath(commands, options)
      for (const command of commands) {
        expect(batch.has(command)).toBe(await isCommandOnLocalPath(command, options))
      }
      expect([...batch].sort()).toEqual(['linkme', 'runme'])
    })

    it('skips relative PATH entries like the absolute-only gate', async () => {
      await expect(
        findCommandsOnLocalPath(['runme'], { platform: 'linux', env: { PATH: '.' }, cwd: dir })
      ).resolves.toEqual(new Set())
    })

    it('skips a missing PATH directory without failing the batch', async () => {
      const missing = path.join(dir, 'does-not-exist')
      await expect(
        findCommandsOnLocalPath(['runme'], {
          platform: 'linux',
          env: { PATH: `${missing}:${dir}` }
        })
      ).resolves.toEqual(new Set(['runme']))
    })
  })

  describe('win32', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'cmd-batch-win32-'))
      await writeFile(path.join(dir, 'tool.CMD'), '@echo off\n')
      await writeFile(path.join(dir, 'MiXeD.CmD'), '@echo off\n')
      await writeFile(path.join(dir, 'literal-cli'), '')
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('resolves bare commands via PATHEXT with the case-insensitive Path key', async () => {
      await expect(
        findCommandsOnLocalPath(['tool', 'other'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.COM;.EXE;.CMD;.BAT' }
        })
      ).resolves.toEqual(new Set(['tool']))
    })

    it('includes fallback extensions even when PATHEXT excludes them', async () => {
      await expect(
        findCommandsOnLocalPath(['tool'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.EXE;.COM' }
        })
      ).resolves.toEqual(new Set(['tool']))
    })

    it('matches Windows filenames case-insensitively', async () => {
      await expect(
        findCommandsOnLocalPath(['mixed'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.CMD' }
        })
      ).resolves.toEqual(new Set(['mixed']))
    })

    it('probes exact host filenames when the directory worker is unavailable', async () => {
      vi.mocked(readDetectionDirectoryViaWorker).mockResolvedValueOnce(null)
      await expect(
        findCommandsOnLocalPath(['tool', 'missing'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.CMD' },
          cwd: dir
        })
      ).resolves.toEqual(new Set(['tool']))
    })

    it('matches extensionless executable names checked by the agent fallback', async () => {
      await expect(
        findCommandsOnLocalPath(['literal-cli'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.EXE' }
        })
      ).resolves.toEqual(new Set(['literal-cli']))
    })
  })
})

// An execute-only directory cannot be listed, but stat on known names still works.
describe.skipIf(process.platform === 'win32')(
  'findCommandsOnLocalPath unreadable PATH entry',
  () => {
    let locked = ''
    beforeAll(async () => {
      locked = await mkdtemp(path.join(tmpdir(), 'cmd-batch-locked-'))
      await writeFile(path.join(locked, 'runme'), '#!/bin/sh\n')
      await chmod(path.join(locked, 'runme'), 0o755)
      await chmod(locked, 0o111)
    })
    afterAll(async () => {
      await chmod(locked, 0o755)
      await rm(locked, { recursive: true, force: true })
    })

    it('probes known names directly when directory listing is denied', async ({ skip }) => {
      const error = await readdir(locked).then(
        () => null,
        (error: unknown) => error
      )
      if (error === null) {
        skip()
        return
      }
      expect(error).toMatchObject({ code: 'EACCES' })
      await expect(
        findCommandsOnLocalPath(['runme', 'missing-a', 'missing-b', 'missing-c', 'missing-d'], {
          platform: 'linux',
          env: { PATH: locked }
        })
      ).resolves.toEqual(new Set(['runme']))
    })
  }
)

describe('findCommandsOnLocalPath shared candidate names', () => {
  it('finds both a bare command and its dotted form when they resolve to the same file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cmd-batch-shared-'))
    try {
      await writeFile(path.join(dir, 'tool.CMD'), '@echo off\n')
      await expect(
        findCommandsOnLocalPath(['tool', 'tool.CMD'], {
          platform: 'win32',
          env: { Path: dir, PATHEXT: '.CMD;.EXE' }
        })
      ).resolves.toEqual(new Set(['tool', 'tool.CMD']))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
