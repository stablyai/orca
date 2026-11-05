import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RangedFileDocuments } from './ranged-file-documents'

let folder: string
let path: string
let documents: RangedFileDocuments
const owner = 'reader-a'

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'orca-range-document-'))
  path = join(folder, 'document.bin')
  documents = new RangedFileDocuments()
})
afterEach(async () => {
  await documents.closeOwner(owner)
  await documents.closeOwner('reader-b')
  await rm(folder, { recursive: true, force: true })
})

function read(id: string, version: number, offset: number, length: number, requestToken = 'read') {
  return documents.read(owner, { id, version, offset, length, requestToken })
}

async function sparse(size: number): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

describe('ranged document owner', () => {
  it('returns exact bytes across EOF and accepts an empty file', async () => {
    await writeFile(path, Buffer.from([0, 1, 2, 255]))
    const document = await documents.open(owner, async () => path)
    expect(document.isBinary).toBe(true)
    expect(await read(document.id, document.version, 2, 8)).toEqual({
      version: 1,
      contentBase64: 'Av8=',
      bytesRead: 2,
      eof: true
    })
    expect(await read(document.id, document.version, 4, 1)).toEqual({
      version: 1,
      contentBase64: '',
      bytesRead: 0,
      eof: true
    })
    await expect(read(document.id, document.version, 5, 1)).rejects.toThrow('invalid_range')
    await documents.close(owner, document.id)
    await writeFile(path, '')
    const empty = await documents.open(owner, async () => path)
    expect(empty.byteLength).toBe(0)
    expect(await read(empty.id, empty.version, 0, 1)).toEqual({
      version: 1,
      contentBase64: '',
      bytesRead: 0,
      eof: true
    })
  })

  it('keeps the native read bounded for a one GiB sparse file and refuses larger files', async () => {
    await sparse(1073741824)
    const document = await documents.open(owner, async () => path)
    expect(document.byteLength).toBe(1073741824)
    const result = await read(document.id, document.version, 1073479680, 262144)
    expect(result.bytesRead).toBe(262144)
    expect(Buffer.from(result.contentBase64, 'base64')).toEqual(Buffer.alloc(262144))
    expect(result.eof).toBe(true)
    await expect(read(document.id, document.version, 0, 262145)).rejects.toThrow('invalid_range')
    await documents.close(owner, document.id)
    await sparse(1073741825)
    await expect(documents.open(owner, async () => path)).rejects.toThrow('File too large')
  })

  it('rejects unsafe offsets and nonpositive or fractional lengths', async () => {
    await writeFile(path, 'hello')
    const document = await documents.open(owner, async () => path)
    for (const [offset, length] of [
      [-1, 1],
      [0.5, 1],
      [Number.MAX_SAFE_INTEGER + 1, 1],
      [0, 0],
      [0, 0.5]
    ]) {
      await expect(read(document.id, document.version, offset, length)).rejects.toThrow()
    }
    expect((await read(document.id, document.version, 0, 5)).contentBase64).toBe('aGVsbG8=')
  })

  it('binds descriptors, reads, reloads and cancellation to their issuing owner', async () => {
    await writeFile(path, 'secret')
    const document = await documents.open(owner, async () => path)
    await expect(
      documents.read('reader-b', {
        id: document.id,
        version: 1,
        offset: 0,
        length: 6,
        requestToken: 'other'
      })
    ).rejects.toThrow('unknown')
    await expect(documents.reload('reader-b', document.id)).rejects.toThrow('unknown')
    await expect(documents.status('reader-b', document.id)).rejects.toThrow('unknown')
    expect(() => documents.cancel('reader-b', document.id, 'read')).toThrow('unknown')
    await expect(documents.close('reader-b', document.id)).rejects.toThrow('unknown')
    expect((await read(document.id, document.version, 0, 6)).contentBase64).toBe('c2VjcmV0')
  })

  it('invalidates replaced files and requires explicit reload before reading the replacement', async () => {
    await writeFile(path, 'old')
    const document = await documents.open(owner, async () => path)
    const replacement = join(folder, 'replacement')
    await writeFile(replacement, 'new bytes')
    await rename(replacement, path)
    const stale = await documents.status(owner, document.id)
    expect(stale.valid).toBe(false)
    await expect(read(document.id, document.version, 0, 3)).rejects.toThrow('stale')
    const reloaded = await documents.reload(owner, document.id)
    expect(reloaded.id).toBe(document.id)
    expect(reloaded.version > document.version).toBe(true)
    expect((await read(reloaded.id, reloaded.version, 0, 9)).contentBase64).toBe('bmV3IGJ5dGVz')
    await expect(read(reloaded.id, document.version, 0, 3)).rejects.toThrow('stale')
  })

  it('refuses a revision changed while a read was validating its current authority', async () => {
    await writeFile(path, 'before')
    let release: (() => void) | undefined
    let checking = false
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const document = await documents.open(owner, async () => {
      if (checking) await barrier
      return path
    })
    checking = true
    const pending = read(document.id, document.version, 0, 6)
    await writeFile(path, 'after!')
    release!()
    await expect(pending).rejects.toThrow()
    expect((await documents.status(owner, document.id)).valid).toBe(false)
  })

  it('retains cancelled read reservations until the unfinished operation settles', async () => {
    await writeFile(path, 'abcdef')
    let checking = false
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const document = await documents.open(owner, async () => {
      if (checking) await barrier
      return path
    })
    checking = true
    const first = read(document.id, document.version, 0, 1, 'first')
    const second = read(document.id, document.version, 1, 1, 'second')
    documents.cancel(owner, document.id, 'first')
    await expect(read(document.id, document.version, 2, 1, 'third')).rejects.toThrow('busy')
    release!()
    await expect(first).rejects.toThrow('cancelled')
    expect((await second).contentBase64).toBe('Yg==')
    expect((await read(document.id, document.version, 2, 1, 'third')).contentBase64).toBe('Yw==')
  })

  it('rechecks revoked file authority and closes all handles on actor cleanup', async () => {
    await writeFile(path, 'secret')
    let authorized = true
    const document = await documents.open(owner, async () => {
      if (!authorized) throw new Error('permission_denied')
      return path
    })
    authorized = false
    await expect(read(document.id, document.version, 0, 6)).rejects.toThrow()
    expect((await documents.status(owner, document.id)).valid).toBe(false)
    await expect(documents.reload(owner, document.id)).rejects.toThrow('permission_denied')
    await documents.closeOwner(owner)
    await expect(documents.status(owner, document.id)).rejects.toThrow('unknown')
  })
})
