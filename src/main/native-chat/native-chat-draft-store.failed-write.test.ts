import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SidecarSnapshotFile from '../sidecar-snapshot-file'

const mocks = vi.hoisted(() => ({
  removeSidecarSnapshot: vi.fn(),
  writeSidecarSnapshot: vi.fn(),
  mkdir: vi.fn()
}))

vi.mock('../sidecar-snapshot-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SidecarSnapshotFile>()
  mocks.removeSidecarSnapshot.mockImplementation(actual.removeSidecarSnapshot)
  mocks.writeSidecarSnapshot.mockImplementation(actual.writeSidecarSnapshot)
  return {
    ...actual,
    removeSidecarSnapshot: mocks.removeSidecarSnapshot,
    writeSidecarSnapshot: mocks.writeSidecarSnapshot
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  mocks.mkdir.mockImplementation(actual.mkdir)
  return { ...actual, mkdir: mocks.mkdir }
})

import { createNativeChatDraftStore } from './native-chat-draft-store'

const roots: string[] = []
const draft = (text: string) => ({ text, attachments: [] })
const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' })

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-drafts-failed-'))
  roots.push(root)
  return join(root, 'native-chat-drafts')
}

async function sentDraftOnDisk() {
  const root = await freshRoot()
  const store = createNativeChatDraftStore(root)
  await store.load()
  await store.write('session:s1', draft('sent text'))
  return { root, store }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// A clear whose delete failed must not leave the sent text to come back, in this run or the next.
describe('a draft write that failed', () => {
  it('is not served to a reloaded window, and is retried when Orca quits', async () => {
    const { root, store } = await sentDraftOnDisk()
    mocks.removeSidecarSnapshot.mockRejectedValueOnce(busy())

    expect(await store.write('session:s1', null)).toBe('failed')
    expect(await store.load()).toEqual([])

    await store.drain()
    expect(await readdir(root)).toEqual([])
    expect(await createNativeChatDraftStore(root).load()).toEqual([])
  })

  it("is superseded by the chat's next write", async () => {
    const { root, store } = await sentDraftOnDisk()
    mocks.removeSidecarSnapshot.mockRejectedValueOnce(busy())
    await store.write('session:s1', null)

    expect(await store.write('session:s1', draft('typed again'))).toBe('persisted')
    await store.drain()

    expect(mocks.removeSidecarSnapshot).toHaveBeenCalledOnce()
    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: draft('typed again') }
    ])
  })

  it('is dropped, and logged, when the retry at quit fails too', async () => {
    const { store } = await sentDraftOnDisk()
    mocks.removeSidecarSnapshot.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy())
    await store.write('session:s1', null)

    await store.drain()
    await store.drain()

    expect(mocks.removeSidecarSnapshot).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped a draft write'),
      'EBUSY'
    )
  })

  it('never outlives a newer write asked for before it failed', async () => {
    const { root, store } = await sentDraftOnDisk()
    mocks.removeSidecarSnapshot.mockRejectedValueOnce(busy())
    const clear = store.write('session:s1', null)
    const next = store.write('session:s1', draft('newer'))

    expect(await clear).toBe('failed')
    expect(await next).toBe('persisted')
    await store.drain()

    expect(mocks.removeSidecarSnapshot).toHaveBeenCalledOnce()
    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: draft('newer') }
    ])
  })
})

describe('the drafts folder', () => {
  it('is created once, and again after a write failed', async () => {
    const root = await freshRoot()
    const store = createNativeChatDraftStore(root)
    await store.write('session:s1', draft('a'))
    await store.write('session:s1', draft('ab'))
    await store.write('session:s2', draft('b'))
    expect(mocks.mkdir).toHaveBeenCalledOnce()

    mocks.writeSidecarSnapshot.mockRejectedValueOnce(busy())
    expect(await store.write('session:s1', draft('abc'))).toBe('failed')
    await store.write('session:s1', draft('abcd'))
    expect(mocks.mkdir).toHaveBeenCalledTimes(2)
  })
})
