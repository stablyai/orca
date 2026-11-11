import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TerminalFileUploadStore } from './terminal-file-upload-store'

const CHUNK = 393216
const NOT_FOUND = 'Terminal file upload was not found'

describe('TerminalFileUploadStore', () => {
  let root: string
  let store: TerminalFileUploadStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'terminal-file-upload-test-'))
    store = new TerminalFileUploadStore(() => root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const pasteDirs = async () => (await readdir(root)).filter((n) => n.startsWith('orca-paste-'))
  const b64 = (bytes: Buffer) => bytes.toString('base64')

  it('stores chunks on disk under orca-paste-<uuid>/<name>', async () => {
    const bytes = Buffer.alloc(CHUNK * 2 + 5)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251
    }
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'лента 1.mp4',
      byteLength: bytes.length
    })
    const receivedLengths: number[] = []
    for (const offset of [0, CHUNK, CHUNK * 2]) {
      const result = await store.append({
        callerKey: 'a',
        uploadId,
        offset,
        contentBase64: b64(bytes.subarray(offset, offset + CHUNK))
      })
      receivedLengths.push(result.receivedLength)
    }
    expect(receivedLengths).toEqual([393216, 786432, 786437])
    const committed = await store.commit({ callerKey: 'a', uploadId })
    expect(committed.path).toMatch(/orca-paste-[0-9a-f-]{36}[\\/]лента 1\.mp4$/)
    expect(committed.byteLength).toBe(786437)
    expect(await readFile(committed.path)).toEqual(bytes)
  })

  it('stores an empty file', async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'empty.txt',
      byteLength: 0
    })
    const committed = await store.commit({ callerKey: 'a', uploadId })
    expect((await readFile(committed.path)).byteLength).toBe(0)
  })

  it('rejects an out-of-order offset', async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'x.bin',
      byteLength: CHUNK * 2
    })
    await expect(
      store.append({
        callerKey: 'a',
        uploadId,
        offset: CHUNK,
        contentBase64: b64(Buffer.alloc(4))
      })
    ).rejects.toThrow()
    await store.abort({ callerKey: 'a', uploadId })
    expect(await pasteDirs()).toEqual([])
  })

  it('rejects bytes beyond the declared length', async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'x.bin',
      byteLength: 3
    })
    await expect(
      store.append({
        callerKey: 'a',
        uploadId,
        offset: 0,
        contentBase64: b64(Buffer.alloc(4))
      })
    ).rejects.toThrow()
  })

  it('refuses commit before all bytes arrive and removes the folder', async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'x.bin',
      byteLength: 10
    })
    await store.append({
      callerKey: 'a',
      uploadId,
      offset: 0,
      contentBase64: b64(Buffer.alloc(4))
    })
    await expect(store.commit({ callerKey: 'a', uploadId })).rejects.toThrow()
    expect(await pasteDirs()).toEqual([])
  })

  it('drops an upload whose chunk write failed, so no retry can commit it', async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'x.bin',
      byteLength: 4
    })
    for (const dir of await pasteDirs()) {
      await rm(join(root, dir), { recursive: true })
    }
    const append = () =>
      store.append({
        callerKey: 'a',
        uploadId,
        offset: 0,
        contentBase64: b64(Buffer.alloc(4))
      })
    await expect(append()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(append()).rejects.toThrow(NOT_FOUND)
    await expect(store.commit({ callerKey: 'a', uploadId })).rejects.toThrow(NOT_FOUND)
    expect(await pasteDirs()).toEqual([])
  })

  it("hides another caller's upload", async () => {
    const { uploadId } = await store.start({
      callerKey: 'a',
      name: 'x.bin',
      byteLength: 2
    })
    const content = b64(Buffer.alloc(2))
    await expect(
      store.append({
        callerKey: 'other',
        uploadId,
        offset: 0,
        contentBase64: content
      })
    ).rejects.toThrow(NOT_FOUND)
    await expect(store.commit({ callerKey: 'other', uploadId })).rejects.toThrow(NOT_FOUND)
    await expect(store.abort({ callerKey: 'other', uploadId })).rejects.toThrow(NOT_FOUND)
    await store.append({
      callerKey: 'a',
      uploadId,
      offset: 0,
      contentBase64: content
    })
    await expect(store.commit({ callerKey: 'a', uploadId })).resolves.toMatchObject({
      byteLength: 2
    })
  })
})
