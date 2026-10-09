import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../../shared/remote-rpc-content-budget'
import { isMobileE2EETextPayloadWithinLimit } from '../../runtime/rpc/mobile-e2ee-outbound-admission'

let root: string
let store: AgentSessionAttachmentStore
const caller = 'client-a'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attachments-'))
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'), {
    hasSession: (sessionId) => sessionId.startsWith('session-')
  })
})

afterEach(async () => {
  store.clearInFlightForTests()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function upload(name: string, bytes: Buffer, sessionId = 'session-1') {
  const { uploadId } = await store.startUpload({
    callerKey: caller,
    sessionId,
    name,
    byteLength: bytes.byteLength
  })
  await store.appendChunk({
    callerKey: caller,
    uploadId,
    offset: 0,
    contentBase64: bytes.toString('base64')
  })
  return store.commitUpload({ callerKey: caller, uploadId })
}

describe('AgentSessionAttachmentStore', () => {
  it('stores the bytes in an upload directory of its own, keeping the file name', async () => {
    const stored = await upload('screen shot.png', Buffer.from('png-bytes'))
    expect(stored.name).toBe('screen shot.png')
    expect(stored.byteLength).toBe(9)
    expect(await readdir(store.rootDir)).toHaveLength(1)
    expect(stored.path.startsWith(store.rootDir)).toBe(true)
    expect(stored.path.endsWith('screen shot.png')).toBe(true)
    expect(await readFile(stored.path, 'utf8')).toBe('png-bytes')
    // The part file is gone once the name holds the whole file.
    expect(await readdir(join(stored.path, '..'))).toEqual(['screen shot.png'])
  })

  it('keeps only the last path segment of a name, never a path out of the store', async () => {
    const stored = await upload('../../../etc/passwd', Buffer.from('x'))
    expect(stored.name).toBe('passwd')
    expect(stored.path.startsWith(store.rootDir)).toBe(true)
  })

  it('refuses an upload for a chat this host does not hold', async () => {
    await expect(
      store.startUpload({ callerKey: caller, sessionId: 'unknown', name: 'a.txt', byteLength: 1 })
    ).rejects.toThrow('not on this host')
    await expect(readdir(store.rootDir)).rejects.toThrow()
  })

  it('appends chunks in order and refuses one out of order or past the declared size', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 4
    })
    const chunk = (text: string) => Buffer.from(text).toString('base64')
    await store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: chunk('ab') })
    await expect(
      store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: chunk('cd') })
    ).rejects.toThrow('out of order')
    await expect(
      store.appendChunk({ callerKey: caller, uploadId, offset: 2, contentBase64: chunk('cde') })
    ).rejects.toThrow('exceeded its declared size')
    await store.appendChunk({ callerKey: caller, uploadId, offset: 2, contentBase64: chunk('cd') })
    const stored = await store.commitUpload({ callerKey: caller, uploadId })
    expect(await readFile(stored.path, 'utf8')).toBe('abcd')
  })

  it('refuses an incomplete commit and removes what it had', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 10
    })
    await expect(store.commitUpload({ callerKey: caller, uploadId })).rejects.toThrow('incomplete')
    expect(await readdir(store.rootDir)).toEqual([])
  })

  it('keeps an upload in flight until its file is renamed into place, so no sweep takes it', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    await store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: 'eA==' })
    const committing = store.commitUpload({ callerKey: caller, uploadId })
    expect(store.isUploadInFlight(uploadId)).toBe(true)
    await committing
    expect(store.isUploadInFlight(uploadId)).toBe(false)
  })

  it('stores an empty file', async () => {
    const stored = await upload('empty.txt', Buffer.alloc(0))
    expect((await stat(stored.path)).size).toBe(0)
  })

  it('does not let another client touch an upload it did not start', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    await expect(
      store.appendChunk({ callerKey: 'client-b', uploadId, offset: 0, contentBase64: 'eA==' })
    ).rejects.toThrow('not found')
    await expect(store.commitUpload({ callerKey: 'client-b', uploadId })).rejects.toThrow(
      'not found'
    )
    await expect(store.abortUpload({ callerKey: 'client-b', uploadId })).rejects.toThrow(
      'not found'
    )
    expect(store.isUploadInFlight(uploadId)).toBe(true)
  })

  it('removes an aborted upload', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    await store.abortUpload({ callerKey: caller, uploadId })
    expect(store.isUploadInFlight(uploadId)).toBe(false)
    expect(await readdir(store.rootDir)).toEqual([])
  })

  it('forgets and removes an upload its client abandoned', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'a.txt',
      byteLength: 1
    })
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await readdir(store.rootDir)).toEqual([]))
    expect(store.isUploadInFlight(uploadId)).toBe(false)
    await expect(store.commitUpload({ callerKey: caller, uploadId })).rejects.toThrow('not found')
  })

  it('reads back a stored image and nothing outside the store', async () => {
    const stored = await upload('shot.png', Buffer.from('png-bytes'))
    await expect(store.readPreview(stored.path)).resolves.toEqual({
      content: Buffer.from('png-bytes').toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
    const outside = join(root, 'outside.png')
    await writeFile(outside, 'secret')
    await expect(store.readPreview(outside)).rejects.toThrow('Not an attachment image')
    const notImage = await upload('notes.txt', Buffer.from('text'))
    await expect(store.readPreview(notImage.path)).rejects.toThrow('Not an attachment image')
  })

  it('reads only a file exactly at <upload>/<name>', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'shot.png',
      byteLength: 3
    })
    const uploadDir = join(store.rootDir, uploadId)
    // Deeper than a stored file: nothing the store wrote lives there.
    await mkdir(join(uploadDir, 'nested'), { recursive: true })
    await writeFile(join(uploadDir, 'nested', 'x.png'), 'x')
    await expect(store.readPreview(join(uploadDir, 'nested', 'x.png'))).rejects.toThrow(
      'Not an attachment image'
    )
  })

  it('never follows a link out of the store', async () => {
    const stored = await upload('shot.png', Buffer.from('png-bytes'))
    const outside = join(root, 'secret.png')
    await writeFile(outside, 'secret')
    await rm(stored.path)
    await symlink(outside, stored.path)
    await expect(store.readPreview(stored.path)).rejects.toThrow('Not an attachment image')
  })

  it('refuses an image over the reply budget instead of overflowing the connection', async () => {
    const big = Buffer.alloc(3.5 * 1024 * 1024, 1)
    const { uploadId } = await store.startUpload({
      callerKey: caller,
      sessionId: 'session-1',
      name: 'big.png',
      byteLength: big.byteLength
    })
    await store.appendChunk({
      callerKey: caller,
      uploadId,
      offset: 0,
      contentBase64: big.toString('base64')
    })
    const stored = await store.commitUpload({ callerKey: caller, uploadId })
    // The budget a remote reply gets: what the server's outbound limit leaves after the envelope.
    await expect(store.readPreview(stored.path, REMOTE_RPC_MAX_CONTENT_BYTES)).rejects.toThrow(
      'file_too_large'
    )
    // A local read keeps the larger preview limit.
    await expect(store.readPreview(stored.path)).resolves.toMatchObject({ mimeType: 'image/png' })
    // An image that fits the budget also fits the server's outbound limit once enveloped.
    const fits = await upload('fits.png', Buffer.alloc(2.5 * 1024 * 1024, 1))
    const preview = await store.readPreview(fits.path, REMOTE_RPC_MAX_CONTENT_BYTES)
    const reply = JSON.stringify({ id: 'request-1', ok: true, result: preview })
    expect(isMobileE2EETextPayloadWithinLimit(reply)).toBe(true)
  })
})
