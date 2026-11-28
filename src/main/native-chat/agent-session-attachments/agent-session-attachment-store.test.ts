import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as Crypto from 'node:crypto'
const fault = vi.hoisted(() => ({ path: '', uuid: '' }))
// The next upload id, so a test can name a folder that already exists.
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof Crypto>()
  return {
    ...crypto,
    randomUUID: () => {
      const next = fault.uuid
      fault.uuid = ''
      return next || crypto.randomUUID()
    }
  }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    readdir: (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === fault.path) {
        throw Object.assign(new Error('listing failed'), { code: 'EIO' })
      }
      return fs.readdir(...args)
    }
  }
})
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  fault.path = ''
  fault.uuid = ''
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the image already in a folder when a later write of the same bytes fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-attachment-store-'))
  roots.push(root)
  const store = new AgentSessionAttachmentStore(root, { hasSession: () => true })
  const bytes = Buffer.from('same image bytes')
  const kept = store.storeContent(bytes, '.png')
  await store.whenWritten(kept)
  const uploadDir = dirname(kept)
  // The same bytes the same day reuse the folder; this write cannot create its part file, and the
  // folder can't be listed while it cleans up.
  await mkdir(join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE))
  fault.path = uploadDir
  const failed = store.storeContent(bytes, '.jpg')
  await store.whenWritten(failed)
  expect(await readFile(kept, 'utf8')).toBe('same image bytes')
})

const TAKEN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

async function storeIn() {
  const root = await mkdtemp(join(tmpdir(), 'orca-attachment-store-'))
  roots.push(root)
  const store = new AgentSessionAttachmentStore(root, { hasSession: () => true })
  const stage = (name: string) => store.stageUpload({ callerKey: 'phone', name, byteLength: 4 })
  return { root, store, stage }
}

it('never adopts or removes a folder that already has the new upload id', async () => {
  const { root, store, stage } = await storeIn()
  const other = join(root, TAKEN, 'other.png')
  await mkdir(dirname(other), { recursive: true })
  await writeFile(other, 'theirs')
  for (const start of [
    () => stage('shot.png'),
    () => store.storeFile('shot.png', Buffer.from('mine'))
  ]) {
    fault.uuid = TAKEN
    await expect(start()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(store.isUploadInFlight(TAKEN)).toBe(false)
    expect(await readFile(other, 'utf8')).toBe('theirs')
  }
})

it('undoes only its own part file when a write, commit, abort or expiry ends an upload', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { root, store, stage } = await storeIn()
  const ends = [
    (uploadId: string) => store.commitUpload({ callerKey: 'phone', uploadId }).catch(() => {}),
    (uploadId: string) => store.abortUpload({ callerKey: 'phone', uploadId }),
    async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    }
  ]
  for (const end of ends) {
    const { uploadId } = await stage('a.png')
    const theirs = join(root, uploadId, 'theirs.png')
    await writeFile(theirs, 'theirs')
    await end(uploadId)
    vi.useRealTimers()
    const part = join(root, uploadId, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await expect.poll(() => exists(part)).toBe(false)
    expect(await readFile(theirs, 'utf8')).toBe('theirs')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  }
  vi.useRealTimers()
  let folder = ''
  await expect(
    store.storeWith('b.png', async (partPath) => {
      folder = dirname(partPath)
      await writeFile(partPath, 'part')
      await writeFile(join(folder, 'theirs.png'), 'theirs')
      throw new Error('copy failed')
    })
  ).rejects.toThrow('copy failed')
  expect(await exists(join(folder, AGENT_SESSION_ATTACHMENT_PART_FILE))).toBe(false)
  expect(await readFile(join(folder, 'theirs.png'), 'utf8')).toBe('theirs')
})

it('still completes uploads and leaves nothing behind when one fails alone', async () => {
  const { root, store, stage } = await storeIn()
  const { uploadId } = await stage('a.png')
  await store.appendChunk({ callerKey: 'phone', uploadId, offset: 0, contentBase64: 'bWluZQ==' })
  const committed = await store.commitUpload({ callerKey: 'phone', uploadId })
  expect(await readFile(committed.path, 'utf8')).toBe('mine')
  expect(await readFile(await store.storeFile('b.png', Buffer.from('file')), 'utf8')).toBe('file')
  const failed = await stage('c.png')
  await store.abortUpload({ callerKey: 'phone', uploadId: failed.uploadId })
  expect(await exists(join(root, failed.uploadId))).toBe(false)
})
