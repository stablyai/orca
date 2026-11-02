import type * as NodeFsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory C: drive; WSL 2.7 answers EPERM for any Windows access to a drive mount over UNC.
const disk = vi.hoisted(() => new Map<string, string>())
const touched = vi.hoisted((): string[] => [])
const fsMock = vi.hoisted(() => {
  const deny = (path: string): void => {
    touched.push(path)
    if (path.startsWith('\\\\')) {
      throw Object.assign(new Error(`EPERM: operation not permitted, '${path}'`), {
        code: 'EPERM'
      })
    }
  }
  const missing = (path: string): Error =>
    Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: 'ENOENT' })
  const fileStats = (content: string) => ({
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    size: Buffer.byteLength(content),
    mtimeMs: 1,
    dev: 1,
    ino: 0
  })
  return {
    open: vi.fn(async (path: string) => {
      deny(path)
      const content = disk.get(path)
      if (content === undefined) {
        throw missing(path)
      }
      return {
        stat: async () => fileStats(content),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytes = Buffer.from(content).subarray(position, position + length)
          bytes.copy(buffer, offset)
          return { bytesRead: bytes.length, buffer }
        },
        close: async () => {}
      }
    }),
    stat: vi.fn(async (path: string) => {
      deny(path)
      const content = disk.get(path)
      if (content === undefined) {
        throw missing(path)
      }
      return fileStats(content)
    }),
    lstat: vi.fn(async (path: string) => {
      deny(path)
      const content = disk.get(path)
      if (content === undefined) {
        throw missing(path)
      }
      return fileStats(content)
    }),
    realpath: vi.fn(async (path: string) => {
      deny(path)
      return path
    }),
    readlink: vi.fn(async (path: string) => {
      deny(path)
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      deny(path)
      disk.set(path, content)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      deny(from)
      deny(to)
      disk.set(to, disk.get(from) ?? '')
      disk.delete(from)
    })
  }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  ...fsMock
}))

import { readLocalFileContent } from '../ipc/filesystem/filesystem-file-content-inspection'
import { readLocalFileRange } from '../ipc/filesystem/local-file-range-read'
import { writeLocalTextFileWithDiskPrecondition } from '../ipc/filesystem/local-disk-write-precondition'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const originalPlatform = process.platform

describe('editor reads and saves of a UNC drive-mount project', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    disk.clear()
    touched.length = 0
    disk.set(String.raw`C:\src\app\README.md`, '# app\n')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('opens, reads a range of, saves and renames the file through its drive path', async () => {
    await expect(readLocalFileContent(`${UNC}\\README.md`)).resolves.toMatchObject({
      content: '# app\n'
    })
    await expect(readLocalFileRange(`${UNC}\\README.md`, 2, 3)).resolves.toMatchObject({
      contentBase64: Buffer.from('app').toString('base64')
    })
    await expect(
      writeLocalTextFileWithDiskPrecondition(`${UNC}\\README.md`, '# saved\n', undefined)
    ).resolves.toEqual({ ok: true })
    expect(disk.get(String.raw`C:\src\app\README.md`)).toBe('# saved\n')
    await renameLocalPathSerializedByDestination(`${UNC}\\README.md`, `${UNC}\\NOTES.md`)
    expect([...disk.keys()]).toEqual([String.raw`C:\src\app\NOTES.md`])
    expect(touched.filter((path) => path.startsWith('\\\\'))).toEqual([])
  })
})
