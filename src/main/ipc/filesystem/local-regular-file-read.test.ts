import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readLocalFileContent } from './filesystem-file-content-inspection'
import {
  assertLocalWriteTargetIsRegularFile,
  NOT_A_REGULAR_FILE_MESSAGE,
  openLocalRegularFile,
  readLocalFileBounded
} from './local-regular-file-read'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-regular-file-read-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('local regular-file reads', () => {
  it('reads a regular file', async () => {
    const filePath = join(base, 'notes.txt')
    await writeFile(filePath, 'hello\n')

    await expect(readLocalFileContent(filePath)).resolves.toEqual({
      content: 'hello\n',
      isBinary: false
    })
  })

  it('refuses a directory', async () => {
    await expect(readLocalFileContent(base)).rejects.toThrow()
  })

  it('caps a read at the limit even when the file is bigger than its handle claimed', async () => {
    const filePath = join(base, 'big.txt')
    await writeFile(filePath, 'a'.repeat(2048))
    const { handle } = await openLocalRegularFile(filePath)
    try {
      await expect(readLocalFileBounded(handle, 1024)).rejects.toThrow('File too large')
    } finally {
      await handle.close()
    }
  })

  it('sizes the read from fstat, so a small file costs a small buffer', async () => {
    const filePath = join(base, 'small.txt')
    await writeFile(filePath, 'hello')
    const { handle, stats } = await openLocalRegularFile(filePath)
    const read = vi.spyOn(handle, 'read')
    try {
      await expect(readLocalFileBounded(handle, 1024 * 1024, stats.size)).resolves.toEqual(
        Buffer.from('hello')
      )
      // One read sized past the reported length, then a 1-byte probe confirming EOF.
      expect(read.mock.calls.map((call) => call.at(2))).toEqual([6, 1])
    } finally {
      await handle.close()
    }
  })

  it('keeps reading a file that grew past its reported size, up to the cap', async () => {
    const filePath = join(base, 'grew.txt')
    await writeFile(filePath, 'a'.repeat(5000))
    const { handle } = await openLocalRegularFile(filePath)
    try {
      await expect(readLocalFileBounded(handle, 1024 * 1024, 10)).resolves.toHaveLength(5000)
      await expect(readLocalFileBounded(handle, 4096, 10)).rejects.toThrow('File too large')
    } finally {
      await handle.close()
    }
  })

  // Why: device files are POSIX-only.
  describe.skipIf(process.platform === 'win32')('non-regular files', () => {
    it.each(['/dev/zero', '/dev/urandom'])(
      'refuses %s before reading any of it',
      async (device) => {
        await expect(readLocalFileContent(device)).rejects.toThrow(NOT_A_REGULAR_FILE_MESSAGE)
      }
    )

    it('refuses a symlink to a device', async () => {
      const link = join(base, 'zero.png')
      await symlink('/dev/zero', link)

      await expect(readLocalFileContent(link)).rejects.toThrow(NOT_A_REGULAR_FILE_MESSAGE)
    })

    it('refuses writing over a device but allows a regular or missing file', async () => {
      const filePath = join(base, 'notes.txt')
      await writeFile(filePath, 'x')

      await expect(assertLocalWriteTargetIsRegularFile('/dev/null')).rejects.toThrow(
        NOT_A_REGULAR_FILE_MESSAGE
      )
      await expect(assertLocalWriteTargetIsRegularFile(filePath)).resolves.toBeUndefined()
      await expect(
        assertLocalWriteTargetIsRegularFile(join(base, 'missing.txt'))
      ).resolves.toBeUndefined()
    })
  })
})
