import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChatForkTransferStore } from './chat-fork-transfer-store'
import type { ChatForkImportLaunch } from './chat-fork-transfer-ownership'

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
    store.commitImport('phone-a', importId, async (staged) => {
      placed = true
      return placedAt(staged.workspacePath)
    })
  ).rejects.toThrow('chat_fork_transfer_integrity_failed')
  expect(placed).toBe(false)
  await expect(readdir(join(root, 'staging', 'imports'))).resolves.toEqual([])
})

function placedAt(cwd: string): ChatForkImportLaunch {
  return {
    agent: 'claude',
    sessionId: '44444444-4444-4444-8444-444444444444',
    filePath: '/home/.claude/projects/-work-target/copy.jsonl',
    cwd,
    worktreeId: 'wt-1',
    resumeCursor: 'cursor-1'
  }
}

async function commitHello(owner: string) {
  const { importId } = await beginHello(owner)
  await store.appendImport(owner, importId, 0, Buffer.from('hello'))
  await store.commitImport(owner, importId, async (staged) => placedAt(staged.workspacePath))
  return importId
}

it('hands a verified upload to placement once, and replays it to a retried commit', async () => {
  const { importId } = await beginHello()
  await store.appendImport('phone-a', importId, 0, Buffer.from('hello'))
  let placements = 0
  const place = async (staged: { workspacePath: string }) => {
    placements += 1
    return placedAt(staged.workspacePath)
  }
  await expect(store.commitImport('phone-a', importId, place)).resolves.toEqual(
    placedAt('/work/target')
  )
  await expect(store.commitImport('phone-a', importId, place)).resolves.toEqual(
    placedAt('/work/target')
  )
  expect(placements).toBe(1)
  await expect(store.commitImport('phone-b', importId, place)).rejects.toThrow(
    'chat_fork_transfer_not_found'
  )
})

it('holds the import cap against begins racing in one tick', async () => {
  const begins = await Promise.allSettled(Array.from({ length: 6 }, () => beginHello('phone-a')))
  expect(begins.filter((begin) => begin.status === 'fulfilled')).toHaveLength(4)
  await expect(readdir(join(root, 'staging', 'imports'))).resolves.toHaveLength(4)
})

it('caps imports per caller, so one caller cannot take every slot', async () => {
  await Promise.all(Array.from({ length: 4 }, () => beginHello('phone-a')))
  await expect(beginHello('phone-a')).rejects.toThrow('chat_fork_transfer_busy')
  await expect(beginHello('phone-b')).resolves.toMatchObject({ chunkBytes: expect.any(Number) })
})

it('evicts only the committing caller’s oldest unlaunched import', async () => {
  const other = await commitHello('phone-b')
  const mine: string[] = []
  for (let i = 0; i < 5; i += 1) {
    mine.push(await commitHello('phone-a'))
  }
  expect(store.findLaunch('phone-b', other)).not.toBeNull()
  expect(store.findLaunch('phone-a', mine[0])).toBeNull()
  expect(store.findLaunch('phone-a', mine[4])).not.toBeNull()
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
