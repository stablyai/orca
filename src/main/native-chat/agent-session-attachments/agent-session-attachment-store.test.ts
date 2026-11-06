import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'

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

  it('never follows a link out of the store', async () => {
    const stored = await upload('shot.png', Buffer.from('png-bytes'))
    const outside = join(root, 'secret.png')
    await writeFile(outside, 'secret')
    await rm(stored.path)
    await symlink(outside, stored.path)
    await expect(store.readPreview(stored.path)).rejects.toThrow('Not an attachment image')
  })

  it('takes a chat not on the host only while its launch lives, and ends with it', async () => {
    const ended = new AbortController()
    let live = true
    const launch = { live: () => live, ended: ended.signal }
    const start = () =>
      store.startUpload({
        callerKey: caller,
        sessionId: 'pending',
        name: 'a.png',
        byteLength: 4,
        launch
      })
    const chunk = Buffer.from('ab').toString('base64')
    // The launch ends while the upload is being allocated: nothing is kept.
    const allocating = start()
    live = false
    await expect(allocating).rejects.toThrow('was not started')
    expect(await readdir(store.rootDir)).toEqual([])
    await expect(start()).rejects.toThrow('not on this host')

    live = true
    const { uploadId } = await start()
    await store.appendChunk({ callerKey: caller, uploadId, offset: 0, contentBase64: chunk })
    live = false
    ended.abort()
    expect(store.isUploadInFlight(uploadId)).toBe(false)
    await expect(
      store.appendChunk({ callerKey: caller, uploadId, offset: 2, contentBase64: chunk })
    ).rejects.toThrow('was not found')
    await vi.waitFor(async () => expect(await readdir(store.rootDir)).toEqual([]))
  })
})
