import { createHash } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { replaceLocalFileBytesIfUnchanged } from './local-disk-bytes-replace'
import { writeLocalTextFileWithDiskPrecondition } from './local-disk-write-precondition'

it.skipIf(process.platform === 'win32')(
  'recreates a deleted binary target where the kernel resolves the link, keeping the link',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-binary-save-'))
    try {
      await mkdir(join(dir, 'real', 'deep'), { recursive: true })
      await mkdir(join(dir, 'proj'))
      const target = join(dir, 'real', 'target.bin')
      const link = join(dir, 'proj', 'edit.bin')
      await writeFile(target, Buffer.from([0, 1, 2]))
      await symlink(join(dir, 'real', 'deep'), join(dir, 'proj', 'sub'), 'dir')
      // `sub/..` is real/, not proj/: the kernel follows sub before applying `..`.
      await symlink('sub/../target.bin', link)
      await symlink('proj', join(dir, 'alias'), 'dir')
      const requested = join(dir, 'alias', 'edit.bin')
      const expectedSha256 = createHash('sha256')
        .update(await readFile(requested))
        .digest('hex')
      await rm(target)

      const result = await replaceLocalFileBytesIfUnchanged(
        requested,
        (temp) => writeFile(temp, Buffer.from([0, 3, 4])),
        { expectedSha256, allowMissing: true }
      )

      expect(result).toEqual({ ok: true })
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(await readlink(link)).toBe('sub/../target.bin')
      expect(await readFile(target)).toEqual(Buffer.from([0, 3, 4]))
      await expect(access(join(dir, 'proj', 'target.bin'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it
  .skipIf(process.platform === 'win32')
  .each(['gone/../target.bin', '../missing-dir/target.bin', 'target.bin/', 'foo/.'])(
  'saves at the path of a dangling %s link the kernel cannot write through',
  async (linkTarget) => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-binary-save-'))
    try {
      await mkdir(join(dir, 'proj'))
      const link = join(dir, 'proj', 'edit.bin')
      await symlink(linkTarget, link)
      const save = (allowMissing: boolean) =>
        replaceLocalFileBytesIfUnchanged(link, (temp) => writeFile(temp, Buffer.from([0, 3, 4])), {
          expectedSha256: 'baseline',
          allowMissing
        })

      await expect(save(false)).resolves.toEqual({ ok: false, diskConflict: 'missing' })
      await expect(
        writeLocalTextFileWithDiskPrecondition(link, 'text', { expectedSignature: 'baseline' })
      ).resolves.toEqual({ ok: false, diskConflict: 'missing' })
      expect(await readlink(link)).toBe(linkTarget)
      await expect(save(true)).resolves.toEqual({ ok: true })
      expect((await lstat(link)).isFile()).toBe(true)
      expect(await readFile(link)).toEqual(Buffer.from([0, 3, 4]))
      expect(await readdir(join(dir, 'proj'))).toEqual(['edit.bin'])
      expect(await readdir(dir)).toEqual(['proj'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)
