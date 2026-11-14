import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChatForkTransferStore } from './chat-fork-transfer-store'

// sha256 of the five bytes "hello".
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const TARGET = { worktreeId: 'wt-1', workspacePath: '/work/target', sourceSessionId: 's-1' }

let root: string
let store: ChatForkTransferStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-chat-fork-transfer-'))
  store = new ChatForkTransferStore(join(root, 'staging'))
})

afterEach(async () => {
  await store.dispose()
  await rm(root, { recursive: true, force: true })
})

async function beginHello(owner = 'phone-a') {
  return store.beginImport(owner, { ...TARGET, byteLength: 5, sha256: HELLO_SHA })
}

it('refuses a chunk that does not continue the upload, and acknowledges a replayed one', async () => {
  const { importId } = await beginHello()
  await expect(store.appendImport('phone-a', importId, 1, Buffer.from('ell'))).rejects.toThrow(
    'chat_fork_transfer_offset_mismatch'
  )
  await expect(store.appendImport('phone-a', importId, 0, Buffer.from('he'))).resolves.toEqual({
    acknowledgedOffset: 2
  })
  await expect(store.appendImport('phone-a', importId, 0, Buffer.from('he'))).resolves.toEqual({
    acknowledgedOffset: 2
  })
})

it('refuses bytes beyond the declared length', async () => {
  const { importId } = await beginHello()
  await expect(store.appendImport('phone-a', importId, 0, Buffer.from('hello!'))).rejects.toThrow(
    'chat_fork_transfer_too_large'
  )
  await expect(store.appendImport('phone-a', importId, 0, Buffer.from('h'))).rejects.toThrow(
    'chat_fork_transfer_not_found'
  )
})

it('fails a commit whose bytes do not match the declared hash, and removes the staged file', async () => {
  const { importId } = await beginHello()
  await store.appendImport('phone-a', importId, 0, Buffer.from('jello'))
  let placed = false
  await expect(
    store.commitImport('phone-a', importId, async () => {
      placed = true
    })
  ).rejects.toThrow('chat_fork_transfer_integrity_failed')
  expect(placed).toBe(false)
  await expect(readdir(join(root, 'staging', 'imports'))).resolves.toEqual([])
})

it('hands a verified upload to placement', async () => {
  const { importId } = await beginHello()
  await store.appendImport('phone-a', importId, 0, Buffer.from('hello'))
  await expect(
    store.commitImport('phone-a', importId, async (staged) => ({
      worktreeId: staged.worktreeId,
      workspacePath: staged.workspacePath
    }))
  ).resolves.toEqual({ worktreeId: 'wt-1', workspacePath: '/work/target' })
})

it('refuses an export read past the end of the cut transcript', async () => {
  const { exportId, byteLength } = await store.createExport('phone-a', async (directory) => {
    const filePath = join(directory, 'copy.jsonl')
    await writeFile(filePath, 'hello')
    return { filePath }
  })
  expect(byteLength).toBe(5)
  await expect(store.readExport('phone-a', exportId, 3, 100)).resolves.toEqual({
    bytesBase64: Buffer.from('lo').toString('base64'),
    eof: true
  })
  await expect(store.readExport('phone-a', exportId, 6, 1)).rejects.toThrow(
    'chat_fork_transfer_offset_mismatch'
  )
})

it('keeps one caller’s transfers from every other caller', async () => {
  const { importId } = await beginHello('phone-a')
  await expect(store.appendImport('phone-b', importId, 0, Buffer.from('hello'))).rejects.toThrow(
    'chat_fork_transfer_not_found'
  )
  expect(store.cancelImport('phone-b', importId)).toBe(false)
  const { exportId } = await store.createExport('phone-a', async (directory) => {
    const filePath = join(directory, 'copy.jsonl')
    await writeFile(filePath, 'hello')
    return { filePath }
  })
  await expect(store.readExport('phone-b', exportId, 0, 5)).rejects.toThrow(
    'chat_fork_transfer_not_found'
  )
  expect(store.releaseExport('phone-b', exportId)).toBe(false)
})
