import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Exercise Windows filename folding through source listings on case-sensitive hosts.
vi.mock('./command-path-directory-worker-client', async () => ({
  readDetectionDirectoryViaWorker: vi.fn(
    (await import('./command-path-directory')).readDetectionDirectory
  )
}))
import {
  findCommandsOnLocalPath,
  isCommandOnLocalPath,
  resolveCommandOnLocalPath
} from './command-path-resolver'

describe('isCommandOnLocalPath', () => {
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

    it('rejects a match reached via a relative PATH entry (absolute-only gate)', async () => {
      await expect(
        isCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: '.' }, cwd: dir })
      ).resolves.toBe(false)
    })
  })
})

describe('win32 PATH lookup', () => {
  let root = ''
  let emptyCwd = ''
  let quotedBin = ''
  let dotBin = ''
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cmd-resolver-win32-'))
    emptyCwd = path.join(root, 'empty-cwd')
    quotedBin = path.join(root, 'bin with spaces')
    dotBin = path.join(root, 'node_modules', '.bin')
    await Promise.all([
      mkdir(emptyCwd, { recursive: true }),
      mkdir(quotedBin, { recursive: true }),
      mkdir(dotBin, { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(quotedBin, 'tool'), '#!/bin/sh\n'),
      writeFile(path.join(quotedBin, 'tool.cmd'), '@echo off\r\n'),
      writeFile(path.join(quotedBin, 'format.v1'), '#!/bin/sh\n'),
      writeFile(path.join(quotedBin, 'format.v1.cmd'), '@echo off\r\n'),
      writeFile(path.join(dotBin, 'prettier'), '#!/bin/sh\n'),
      writeFile(path.join(dotBin, 'prettier.cmd'), '@echo off\r\n')
    ])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('resolves commands from quoted Windows PATH entries in single and batch lookups', async () => {
    const options = {
      platform: 'win32' as const,
      cwd: emptyCwd,
      env: { PATH: `"${quotedBin}"`, PATHEXT: '.EXE;.cmd' }
    }
    await expect(resolveCommandOnLocalPath('tool', options)).resolves.toBe(
      path.posix.join(quotedBin, 'tool.cmd')
    )
    await expect(findCommandsOnLocalPath(['tool'], options)).resolves.toEqual(new Set(['tool']))
  })

  it('keeps single quotes in Windows PATH entries literal', async () => {
    const options = {
      platform: 'win32' as const,
      cwd: emptyCwd,
      env: { PATH: `'${quotedBin}'`, PATHEXT: '.EXE;.cmd' }
    }
    await expect(resolveCommandOnLocalPath('tool', options)).resolves.toBeNull()
    await expect(findCommandsOnLocalPath(['tool'], options)).resolves.toEqual(new Set())
  })

  it('ignores dots in parent directories so path-qualified lookups do not match POSIX siblings', async () => {
    const target = path.join(dotBin, 'prettier')
    await expect(
      resolveCommandOnLocalPath(target, {
        platform: 'win32',
        cwd: emptyCwd,
        env: { PATH: '', PATHEXT: '.EXE;.cmd' }
      })
    ).resolves.toBe(`${target}.cmd`)
  })

  it('keeps the exact-name-first match for dotted basenames', async () => {
    await expect(
      resolveCommandOnLocalPath('format.v1', {
        platform: 'win32',
        cwd: emptyCwd,
        env: { PATH: quotedBin, PATHEXT: '.EXE;.cmd' }
      })
    ).resolves.toBe(path.posix.join(quotedBin, 'format.v1'))
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
