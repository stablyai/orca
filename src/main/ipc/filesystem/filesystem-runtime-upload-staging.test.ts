import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeImportLimits from '../runtime-import-limits'

type RuntimeImportLimitsModule = typeof RuntimeImportLimits

// Scale down gigabyte ceilings: NTFS truncate may allocate the entire oversized fixture.
vi.mock('../runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<RuntimeImportLimitsModule>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 4 * 1024,
  REMOTE_IMPORT_MAX_TOTAL_BYTES: 16 * 1024
}))

const { stageOneSourceForRuntimeUpload } = await import('./filesystem-runtime-upload-staging')

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orca-upload-staging-'))
})

afterEach(async () => {
  await rm(workDir, { force: true, recursive: true })
})

describe('stageOneSourceForRuntimeUpload', () => {
  it('counts earlier sources in the drop against the total ceiling', async () => {
    const filePath = join(workDir, 'second.bin')
    await writeFile(filePath, Buffer.alloc(3 * 1024))

    await expect(stageOneSourceForRuntimeUpload(filePath, 0)).resolves.toMatchObject({
      status: 'staged'
    })
    const overBudget = await stageOneSourceForRuntimeUpload(filePath, 14 * 1024)
    expect(overBudget).toMatchObject({ status: 'failed' })
    expect(overBudget.status === 'failed' && overBudget.reason).toContain(
      'total remote import limit'
    )
  })

  // symlink() needs privileges or Developer Mode on Windows.
  it.skipIf(process.platform === 'win32')('keeps rejecting symlinked sources', async () => {
    const targetPath = join(workDir, 'target.txt')
    await writeFile(targetPath, 'data')
    const linkPath = join(workDir, 'link.txt')
    await symlink(targetPath, linkPath)

    await expect(stageOneSourceForRuntimeUpload(linkPath)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'symlink'
    })
  })

  describe('a dropped file with no extension', () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

    const stage = (path: string) =>
      stageOneSourceForRuntimeUpload(path, 0, { nameExtensionlessImages: true })

    it('gets the extension its image bytes declare', async () => {
      const filePath = join(workDir, 'noname')
      await writeFile(filePath, PNG_HEADER)

      await expect(stage(filePath)).resolves.toMatchObject({
        status: 'staged',
        name: 'noname.png',
        entries: [{ relativePath: '', kind: 'file', byteLength: PNG_HEADER.length }]
      })
    })
  })
})
