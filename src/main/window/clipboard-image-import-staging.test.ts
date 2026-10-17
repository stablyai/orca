import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PNG as Png } from 'pngjs'
import { ClipboardImageImportStaging } from './clipboard-image-import-staging'
import { getOwnedTempStagingRoot } from './owned-temp-staging-root'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../shared/clipboard-image'
import type { ClipboardImageImport } from '../../shared/clipboard-image-import'
import { importOneSource } from '../ipc/filesystem-import-local'
import { stageOneSourceForRuntimeUpload } from '../ipc/filesystem-runtime-upload-staging'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) }
})

// A real 2x2 PNG with opaque, translucent and transparent pixels.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4AQXBAQEAAAjDIN7c5hNEciOlBz3iB3s97fKpAAAAAElFTkSuQmCC',
  'base64'
)

describe('clipboard image import staging', () => {
  let folder: string
  let root: string
  let staging: ClipboardImageImportStaging
  let owner: AbortController

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'orca-image-import-test-'))
    root = getOwnedTempStagingRoot(folder, 'clipboard-image-imports')
    staging = new ClipboardImageImportStaging(folder)
    owner = new AbortController()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(folder, { recursive: true, force: true })
  })

  it('imports real bytes with a readable name, deconflicts, then removes only the snapshot', async () => {
    const destination = join(folder, 'pasta com espaços e acentuação')
    await mkdir(destination)
    const snapshot = await staging.stage(17, PNG, owner.signal)
    expect(snapshot.path).toBe(join(root, snapshot.handle, 'pasted-image.png'))
    expect(await readFile(snapshot.path)).toEqual(PNG)
    for (const name of ['pasted-image.png', 'pasted-image copy.png']) {
      const result = await importOneSource(snapshot.path, destination, new Set())
      expect(result).toMatchObject({ status: 'imported', destPath: join(destination, name) })
      expect(await readFile(join(destination, name))).toEqual(PNG)
      const decoded = Png.sync.read(await readFile(join(destination, name)))
      expect([decoded.width, decoded.height]).toEqual([2, 2])
      expect(decoded.data).toEqual(
        Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255])
      )
    }
    expect(await staging.release(17, snapshot.handle)).toBe(true)
    expect(await readdir(root)).toEqual([])
    expect(await readFile(join(destination, 'pasted-image.png'))).toEqual(PNG)
    expect(await staging.release(17, snapshot.handle)).toBe(false)
  })

  it('can stage the snapshot for the existing runtime upload without changing its name', async () => {
    const snapshot = await staging.stage(17, PNG, owner.signal)
    const upload = await stageOneSourceForRuntimeUpload(snapshot.path)
    expect(upload).toMatchObject({
      status: 'staged',
      name: 'pasted-image.png',
      sourcePath: snapshot.path
    })
    await staging.release(17, snapshot.handle)
  })

  it('takes a stable copy before any filesystem await', async () => {
    const bytes = Buffer.from(PNG)
    const pending = staging.stage(17, bytes, owner.signal)
    bytes.fill(0)
    const snapshot = await pending
    expect(await readFile(snapshot.path)).toEqual(PNG)
  })

  it('refuses foreign handles, paths and malformed input without deleting anything', async () => {
    const snapshot = await staging.stage(17, PNG, owner.signal)
    expect(await staging.release(18, snapshot.handle)).toBe(false)
    for (const invalid of [null, {}, 17, '../', snapshot.path, folder, randomUUID()]) {
      expect(await staging.release(17, invalid)).toBe(false)
    }
    expect(await readFile(snapshot.path)).toEqual(PNG)
  })

  it('keeps concurrent snapshots separate and releases only one owner', async () => {
    const snapshots = await Promise.all([
      staging.stage(17, PNG, owner.signal),
      staging.stage(18, PNG, owner.signal),
      staging.stage(17, PNG, owner.signal)
    ])
    expect(new Set(snapshots.map((entry) => entry.path)).size).toBe(3)
    await staging.releaseOwner(17)
    expect(await readdir(root)).toEqual([snapshots[1].handle])
  })

  it('bounds concurrent image encoding and allows new imports after release', async () => {
    const pending = Array.from({ length: 8 }, () => staging.stage(17, PNG, owner.signal))
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow('Too many')
    const snapshots = await Promise.all(pending)
    await staging.release(17, snapshots[0].handle)
    await expect(staging.stage(17, PNG, owner.signal)).resolves.toMatchObject({
      path: expect.any(String)
    })
  })

  it('retains a full undo history but bounds completed snapshots', async () => {
    const snapshots: ClipboardImageImport[] = []
    for (let index = 0; index < 64; index += 1) {
      snapshots.push(await staging.stage(17, PNG, owner.signal))
    }
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow('Too many')
    await staging.release(17, snapshots[0].handle)
    await expect(staging.stage(17, PNG, owner.signal)).resolves.toMatchObject({
      path: expect.any(String)
    })
    await staging.releaseOwner(17)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects empty, oversized and already-cancelled images before allocating files', async () => {
    await expect(staging.stage(17, Buffer.alloc(0), owner.signal)).rejects.toThrow('empty')
    await expect(
      staging.stage(17, Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1), owner.signal)
    ).rejects.toThrow('too large')
    owner.abort()
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow()
    expect(await readdir(folder)).toEqual([])
  })

  it('removes partial output on a failed write and lets the next attempt succeed', async () => {
    const originalWrite = vi.mocked(writeFile).getMockImplementation()!
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await originalWrite(...args)
      throw new Error('disk full')
    })
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow('disk full')
    expect(await readdir(root)).toEqual([])
    await expect(staging.stage(17, PNG, owner.signal)).resolves.toMatchObject({
      path: expect.any(String)
    })
  })

  it('cleans a write that finishes after its renderer was lost', async () => {
    const originalWrite = vi.mocked(writeFile).getMockImplementation()!
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await originalWrite(...args)
      owner.abort()
    })
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
  })

  it('retains a handle when deletion fails so release can be retried', async () => {
    const snapshot = await staging.stage(17, PNG, owner.signal)
    vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
    await expect(staging.release(17, snapshot.handle)).rejects.toThrow('file busy')
    expect(await readFile(snapshot.path)).toEqual(PNG)
    expect(await staging.release(17, snapshot.handle)).toBe(true)
    expect(await readdir(root)).toEqual([])
  })

  it('sweeps only expired owned directories, preserving live imports and unrelated data', async () => {
    const live = await staging.stage(17, PNG, owner.signal)
    const abandoned = await staging.stage(18, PNG, owner.signal)
    const fresh = await staging.stage(18, PNG, owner.signal)
    const other = join(root, 'unrelated')
    await mkdir(other)
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await Promise.all(
      [dirname(live.path), dirname(abandoned.path), other].map((path) => utimes(path, old, old))
    )
    await staging.sweepExpired()
    expect(await readFile(live.path)).toEqual(PNG)
    expect(await readFile(abandoned.path)).toEqual(PNG)
    // A new process has no live handles, so old snapshots are now crash leftovers.
    await new ClipboardImageImportStaging(folder).sweepExpired()
    expect((await readdir(root)).sort()).toEqual([fresh.handle, 'unrelated'].sort())
  })

  it('recovers a failed owner cleanup through the expiry sweep', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const snapshot = await staging.stage(17, PNG, owner.signal)
    vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
    await staging.releaseOwner(17)
    expect(log).toHaveBeenCalledOnce()
    expect(await readFile(snapshot.path)).toEqual(PNG)
    await staging.sweepExpired(Date.now() + 48 * 60 * 60 * 1000)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses a staging root replaced with a directory link', async () => {
    const outside = join(folder, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(staging.stage(17, PNG, owner.signal)).rejects.toThrow('unsafe')
    await expect(staging.sweepExpired()).rejects.toThrow('unsafe')
    expect(await readdir(outside)).toEqual(['keep.txt'])
  })

  it('refuses to release a directory replaced with a link to unrelated data', async () => {
    const snapshot = await staging.stage(17, PNG, owner.signal)
    const outside = join(folder, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await rm(dirname(snapshot.path), { recursive: true })
    await symlink(
      outside,
      dirname(snapshot.path),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(staging.release(17, snapshot.handle)).rejects.toThrow('unsafe')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')(
    'creates private POSIX directories and files',
    async () => {
      const snapshot = await staging.stage(17, PNG, owner.signal)
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(dirname(snapshot.path))).mode & 0o777).toBe(0o700)
      expect((await stat(snapshot.path)).mode & 0o777).toBe(0o600)
    }
  )
})
