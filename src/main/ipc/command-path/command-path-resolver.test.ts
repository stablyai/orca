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

    it('resolves the absolute path of the executable it found', async () => {
      await expect(
        resolveCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(path.posix.join(dir, 'runme'))
      await expect(
        resolveCommandOnLocalPath('plain', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBeNull()
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
