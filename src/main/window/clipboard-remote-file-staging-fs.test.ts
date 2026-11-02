import { afterEach, describe, expect, it } from 'vitest'
import { access, lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  cleanupExpiredRemoteClipboardStaging,
  createRemoteClipboardTransferDirectory,
  getRemoteClipboardStagingRoot,
  RemoteClipboardStagingRootUnsafeError
} from './clipboard-remote-file-staging'

const FIXTURE_PREFIX = 'orca-clipboard-staging-test-'
const NOW_MS = 1_760_000_000_000
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      expect(dirname(fixture)).toBe(tmpdir())
      expect(basename(fixture)).toMatch(new RegExp(`^${FIXTURE_PREFIX}`))
      await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    })
  )
})

describe('remote clipboard staging filesystem contract', () => {
  it('removes only expired owned transfers with real filesystem metadata', async () => {
    const tempRoot = await makeFixture()
    const foreignDirectory = join(tempRoot, 'foreign-directory')
    await mkdir(foreignDirectory)
    const expiredTransfer = await createRemoteClipboardTransferDirectory(
      tempRoot,
      NOW_MS - 2 * 60 * 60 * 1000,
      '00000000-0000-4000-8000-000000000000'
    )
    const freshTransfer = await createRemoteClipboardTransferDirectory(
      tempRoot,
      NOW_MS,
      '00000000-0000-4000-8000-000000000001'
    )
    const expiredAt = new Date(NOW_MS - 2 * 60 * 60 * 1000)
    await utimes(expiredTransfer, expiredAt, expiredAt)

    await cleanupExpiredRemoteClipboardStaging(tempRoot, NOW_MS)

    await expect(access(expiredTransfer)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(freshTransfer)).resolves.toBeUndefined()
    await expect(access(foreignDirectory)).resolves.toBeUndefined()
    if (typeof process.getuid === 'function') {
      const rootStats = await lstat(getRemoteClipboardStagingRoot(tempRoot))
      expect(rootStats.uid).toBe(process.getuid())
      expect(rootStats.mode & 0o777).toBe(0o700)
    }
  })

  it('rejects a real staging-root symlink without writing through it', async () => {
    const tempRoot = await makeFixture()
    const outsideDirectory = join(tempRoot, 'outside')
    const stagingRoot = getRemoteClipboardStagingRoot(tempRoot)
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, stagingRoot, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      createRemoteClipboardTransferDirectory(
        tempRoot,
        NOW_MS,
        '00000000-0000-4000-8000-000000000000'
      )
    ).rejects.toBeInstanceOf(RemoteClipboardStagingRootUnsafeError)

    expect(await readdir(outsideDirectory)).toEqual([])
  })
})

async function makeFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX))
  fixtures.push(fixture)
  return fixture
}
