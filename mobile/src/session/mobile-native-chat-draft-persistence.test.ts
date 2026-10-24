import { createElement } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { copyMobileQueuedMessageToDraft } from './mobile-native-chat-queued-extraction'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-send-mutation'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, expect, it, vi } from 'vitest'
import {
  editMobileNativeChatDraft,
  hydrateMobileNativeChatDraft,
  persistMobileNativeChatDraft,
  readMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  deleteMobileNativeChatDrafts,
  appendMobileNativeChatDraft,
  clearMobileNativeChatDraftForSend,
  captureMobileChatDraftOwner,
  restoreMobileChatDraft,
  updateMobileNativeChatDraftImages
} from './mobile-native-chat-draft-store'
import {
  mobileChatDraftStorageKey,
  MOBILE_CHAT_DRAFT_CHUNK_CHARS
} from './mobile-native-chat-draft-data'
import * as draftStorage from './mobile-native-chat-draft-storage'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import {
  installNativeMobileChatDraftStorage,
  removeStoredMobileChatDrafts,
  nativeChatDraftSession,
  writeNativeMobileChatDraft,
  readNativeMobileChatDraft,
  closeNativeChatDraftSession
} from './mobile-native-chat-draft-native-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import {
  createBridgeDraftWriter,
  pageMayAccessChatDraft
} from '../mobile-web-shell/bridge/bridge-draft-storage'
import {
  isBridgeFrameWithinCap,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import { pageStorageKeysForRoute } from '../mobile-web-shell/page-storage-keys'

const appState = vi.hoisted(() => new Set<(state: string) => void>())
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.add(listener)
      return { remove: () => appState.delete(listener) }
    }
  }
}))

const filePicker = vi.hoisted(() => vi.fn())
const uploadFile = vi.hoisted(() => vi.fn())
vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => ({ pickFiles: filePicker }) }))
vi.mock('./mobile-agent-session-attachment-upload', () => ({
  uploadMobileAgentSessionAttachment: uploadFile
}))

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    getAllKeys: async () => [...disk.keys()],
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetMobileNativeChatDraftStoreForTests()
  publishMobileChatDraftStorage(null)
})

it('commits a large image/skill draft before acknowledgement, restores it, and deletes only its workspace', async () => {
  const scope = 'host\0workspace\0tab'
  const key = mobileChatDraftStorageKey(scope)
  const other = mobileChatDraftStorageKey('host\0other\0tab')
  const value = JSON.stringify({
    text: `${'"\\\n'.repeat(40_000)}$review`,
    images: [
      {
        id: 'remote',
        path: '',
        reference: { url: 'https://example.com/image.png', alt: 'diagram' }
      }
    ],
    skills: [{ name: 'review', path: '/skills/review' }]
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = createBridgeDraftWriter({
    mayWrite: (candidate) =>
      pageMayAccessChatDraft(candidate, 'host', '/h/host/session/workspace', false),
    commit: async (candidate, content) => {
      await gate
      await persistMirrored(candidate, content)
    },
    removeWorkspace: removeStoredMobileChatDrafts
  })
  expect(pageStorageKeysForRoute('host', '/h/host/session/workspace')).not.toContain(key)
  expect(pageMayAccessChatDraft(other, 'host', '/h/host/session/workspace', false)).toBe(false)
  expect(utf8ByteLength(JSON.stringify({ value }))).toBeLessThan(BRIDGE_MAX_REPLY_BYTES)
  const total = Math.ceil(value.length / MOBILE_CHAT_DRAFT_CHUNK_CHARS)
  let final: Promise<{ committed: boolean }> | undefined
  for (let index = 0; index < total; index++) {
    const params = {
      key,
      writeId: 'one',
      index,
      total,
      value: value.slice(
        index * MOBILE_CHAT_DRAFT_CHUNK_CHARS,
        (index + 1) * MOBILE_CHAT_DRAFT_CHUNK_CHARS
      )
    }
    expect(
      isBridgeFrameWithinCap(
        JSON.stringify({ kind: 'request', method: 'native.storage.write', params })
      )
    ).toBe(true)
    if (index === total - 1) {
      final = writer.write(params)
    } else {
      expect(await writer.write(params)).toEqual({ committed: false })
    }
  }
  expect(disk.has(key)).toBe(false)
  release()
  expect(await final).toEqual({ committed: true })
  installNativeMobileChatDraftStorage()
  await hydrateMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope)).toMatchObject(JSON.parse(value))
  editMobileNativeChatDraft(scope, 'edited $review')
  await persistMobileNativeChatDraft(scope)
  resetMobileNativeChatDraftStoreForTests()
  await hydrateMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope)).toMatchObject({
    text: 'edited $review',
    images: JSON.parse(value).images,
    skills: JSON.parse(value).skills
  })
  await persistMirrored(other, value)
  await deleteMobileNativeChatDrafts('host', 'workspace')
  expect(disk.has(key)).toBe(false)
  expect(disk.has(other)).toBe(true)
  await deleteMobileNativeChatDrafts('host')
  expect(disk.has(other)).toBe(false)
  writer.dispose()
})

it('owns the complete base before editing and protects unread drafts through memory-only Send and recovery', async () => {
  const scope = 'race\0workspace\0tab'
  let loaded = (_value: string | null) => {}
  let read = new Promise<string | null>((resolve) => {
    loaded = resolve
  })
  const write = vi.fn(async () => {})
  publishMobileChatDraftStorage({ read: () => read, write, removeWorkspace: async () => {} })
  const hydration = hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'too early')
  expect(readMobileNativeChatDraft(scope).text).toBe('')
  loaded('unreadable')
  await hydration
  editMobileNativeChatDraft(scope, 'sent during recovery')
  clearMobileNativeChatDraftForSend(
    captureMobileChatDraftOwner(scope),
    readMobileNativeChatDraft(scope).editGeneration,
    'sent during recovery'
  )
  editMobileNativeChatDraft(scope, 'currently unsent')
  await expect(persistMobileNativeChatDraft(scope)).rejects.toThrow('Draft was not saved')
  expect(write).not.toHaveBeenCalled()
  read = Promise.resolve(JSON.stringify({ text: '/clear', images: [] }))
  await hydrateMobileNativeChatDraft(scope)
  await persistMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope).text).toBe('/clear\n\ncurrently unsent')
  await persistMobileNativeChatDraft(scope)
  expect(write).toHaveBeenCalledOnce()
  editMobileNativeChatDraft(scope, (text) => `${text}!`)
  write.mockRejectedValueOnce(new Error('disk full'))
  await expect(persistMobileNativeChatDraft(scope)).rejects.toThrow('disk full')
})

it('orders acknowledged writes to one key while letting another key commit', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, value) => {
    await gate
    disk.set(key, value)
  })
  const first = persistMirrored('ordered', 'first')
  const second = persistMirrored('ordered', 'second')
  await persistMirrored('independent', 'other')
  expect(disk.has('ordered')).toBe(false)
  expect(disk.get('independent')).toBe('other')
  release()
  await Promise.all([first, second])
  expect(disk.get('ordered')).toBe('second')
  held.mockRestore()
})

it('binds extracted files to their own text and permanently prunes deleted tokens across reload', async () => {
  installNativeMobileChatDraftStorage()
  const scope = 'skills\0workspace\0tab'
  const skills = [
    { name: 'review', path: '/one' },
    { name: 'review', path: '/two' }
  ]
  await hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, '$review existing')
  await copyMobileQueuedMessageToDraft(scope, {
    messageId: 'picked',
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '$review' }], skills }
  })
  expect(readMobileNativeChatDraft(scope).skills).toEqual([skills[0]])
  editMobileNativeChatDraft(scope, 'no selection')
  editMobileNativeChatDraft(scope, '$review retyped')
  await persistMobileNativeChatDraft(scope)
  resetMobileNativeChatDraftStoreForTests()
  await hydrateMobileNativeChatDraft(scope)
  const draft = readMobileNativeChatDraft(scope)
  expect(draft.text).toBe('$review retyped')
  expect(structuredAgentSessionSendBody(draft.text, [], draft.skills).skills).toBeUndefined()
})

it('fills accessible queued image previews through the existing resolver without changing references', async () => {
  installNativeMobileChatDraftStorage()
  const scope = 'preview\0workspace\0tab'
  const reference = { type: 'image-ref' as const, path: '/repo/image.png', alt: 'diagram' }
  let resolvePreview = (_value: unknown) => {}
  const client = {
    sendRequest: vi.fn(async (method: string) =>
      method === 'files.resolveTerminalPath'
        ? {
            ok: true,
            result: {
              exists: true,
              isDirectory: false,
              worktree: 'workspace',
              relativePath: 'image.png'
            }
          }
        : new Promise<unknown>((resolve) => {
            resolvePreview = resolve
          })
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture returns only the existing resolver and image-preview success envelopes.
  const sender = client as Parameters<typeof copyMobileQueuedMessageToDraft>[2]
  expect(
    await copyMobileQueuedMessageToDraft(
      scope,
      {
        messageId: 'image',
        position: 1,
        state: 'waiting',
        body: { kind: 'message', role: 'user', blocks: [reference] }
      },
      sender
    )
  ).toBeTruthy()
  await vi.waitFor(() =>
    expect(client.sendRequest).toHaveBeenCalledWith('files.readPreview', {
      worktree: 'id:workspace',
      relativePath: 'image.png'
    })
  )
  expect(readMobileNativeChatDraft(scope).images[0]?.previewUri).toBe('')
  resolvePreview({
    ok: true,
    result: { isBinary: true, isImage: true, mimeType: 'image/png', content: 'eA==' }
  })
  await vi.waitFor(() =>
    expect(readMobileNativeChatDraft(scope).images[0]?.previewUri).toBe(
      'data:image/png;base64,eA=='
    )
  )
  expect(readMobileNativeChatDraft(scope).images[0]?.reference).toEqual({
    path: reference.path,
    alt: reference.alt
  })
  await persistMobileNativeChatDraft(scope)
})

it('serializes admitted new keys with removal and fences scoped document authority across writer reconstruction', async () => {
  installNativeMobileChatDraftStorage()
  const a = mobileChatDraftStorageKey('native-race\0a\0tab')
  const b = mobileChatDraftStorageKey('native-race\0b\0tab')
  const c = mobileChatDraftStorageKey('native-race\0c\0tab')
  const value = JSON.stringify({ text: 'saved', images: [] })
  const check = nativeChatDraftSession('document-one')
  const makeWriter = () =>
    createBridgeDraftWriter({
      mayWrite: () => true,
      check,
      commit: writeNativeMobileChatDraft,
      removeWorkspace: removeStoredMobileChatDrafts
    })
  let writer = makeWriter()
  await writer.write({ key: a, writeId: 'partial', index: 0, total: 2, value: '{' })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, text) => {
    await gate
    disk.set(key, text)
  })
  const admitted = writeNativeMobileChatDraft(a, value)
  await Promise.resolve()
  const removal = removeStoredMobileChatDrafts('native-race', 'a')
  await expect(writeNativeMobileChatDraft(a, value)).rejects.toThrow()
  await expect(
    writer.write({ key: a, writeId: 'partial', index: 1, total: 2, value: '}' })
  ).rejects.toThrow()
  release()
  await Promise.all([admitted, removal])
  expect(disk.has(a)).toBe(false)
  writer.dispose()
  await expect(
    writer.write({ key: b, writeId: 'closed', index: 0, total: 1, value })
  ).rejects.toThrow()
  writer = makeWriter()
  await expect(
    writer.write({ key: a, writeId: 'old-session', index: 0, total: 1, value })
  ).rejects.toThrow()
  await writer.write({ key: b, writeId: 'b', index: 0, total: 1, value })
  await writer.write({ key: c, writeId: 'unopened-c', index: 0, total: 1, value })
  expect(disk.get(b)).toBe(value)
  expect(disk.get(c)).toBe(value)
  const fresh = nativeChatDraftSession('document-two')
  fresh(a)
  await writeNativeMobileChatDraft(a, value)
  await expect(readNativeMobileChatDraft(a, check)).rejects.toThrow()
  expect(await readNativeMobileChatDraft(a, fresh)).toBe(value)
  held.mockRestore()
  const secondKey = mobileChatDraftStorageKey('native-race\0a\0other-tab')
  await writeNativeMobileChatDraft(secondKey, value)
  const stale = readNativeMobileChatDraft(a, fresh)
  let finishCleanup = () => {}
  const cleanupGate = new Promise<void>((resolve) => {
    finishCleanup = resolve
  })
  const enumeration = vi.spyOn(AsyncStorage, 'getAllKeys')
  const cleanup = vi.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key) => {
    if (key === a) {
      throw new Error('storage refused')
    }
    await cleanupGate
    disk.delete(key)
  })
  const failedRemoval = deleteMobileNativeChatDrafts('native-race', 'a')
  expect(removeStoredMobileChatDrafts('native-race', 'a')).toBe(failedRemoval)
  await expect(stale).rejects.toThrow()
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2))
  const duringCleanup = nativeChatDraftSession('document-during-cleanup')
  await expect(readNativeMobileChatDraft(a, duringCleanup)).rejects.toThrow()
  expect(removeStoredMobileChatDrafts('native-race', 'a')).toBe(failedRemoval)
  expect(enumeration).toHaveBeenCalledTimes(1)
  finishCleanup()
  await expect(failedRemoval).rejects.toThrow('storage refused')
  await expect(writeNativeMobileChatDraft(a, value)).rejects.toThrow()
  expect(enumeration).toHaveBeenCalledTimes(1)
  cleanup.mockImplementation(async (key) => {
    disk.delete(key)
  })
  await hydrateMobileNativeChatDraft('native-race\0a\0tab')
  await removeStoredMobileChatDrafts('native-race', 'a')
  expect(enumeration).toHaveBeenCalledTimes(2)
  expect(disk.has(a)).toBe(false)
  expect(disk.has(secondKey)).toBe(false)
  fresh(b)
  fresh(c)
  expect(() => fresh(a)).toThrow()
  const afterCleanup = nativeChatDraftSession('document-after-cleanup')
  await writeNativeMobileChatDraft(a, value)
  expect(await readNativeMobileChatDraft(a, afterCleanup)).toBe(value)
  writer.dispose()
  closeNativeChatDraftSession('document-one')
  closeNativeChatDraftSession('document-two')
  closeNativeChatDraftSession('document-during-cleanup')
  closeNativeChatDraftSession('document-after-cleanup')
})

it('coalesces typing around an exact copy and never authorizes a removed or expired copy', async () => {
  const scope = 'pump\0workspace\0tab'
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = vi.fn(async (_key: string, _value: string | null) => {})
  write.mockImplementationOnce(() => gate)
  publishMobileChatDraftStorage({ read: async () => null, write, removeWorkspace: async () => {} })
  await hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'old')
  const active = persistMobileNativeChatDraft(scope)
  await Promise.resolve()
  for (let index = 0; index < 100; index++) {
    editMobileNativeChatDraft(scope, `typing ${index}`)
  }
  const pending = appendMobileNativeChatDraft(scope, { text: 'copied', images: [] })
  await Promise.resolve()
  release()
  const copy = await pending
  await active
  expect(copy && copy.valid()).toBe(true)
  expect(write).toHaveBeenCalledTimes(2)
  expect(JSON.parse(write.mock.calls[1]![1]!).text).toBe('typing 99\n\ncopied')
  await deleteMobileNativeChatDrafts('pump', 'workspace')
  expect(copy && copy.valid()).toBe(false)
  await hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'fresh owner')
  expect(readMobileNativeChatDraft(scope).text).toBe('fresh owner')
  await persistMobileNativeChatDraft(scope)
  expect(captureMobileChatDraftOwner(scope)).toBeDefined()
})

/** Each write waits for the test to settle it; `saved` is what a reload reads. */
function heldWrites() {
  const writes: { value: string | null; settle: (error?: Error) => void }[] = []
  const state: { saved: string | null; inFlight: number; peak: number } = {
    saved: null,
    inFlight: 0,
    peak: 0
  }
  const write = vi.fn(
    (_key: string, value: string | null) =>
      new Promise<void>((resolve, reject) => {
        state.peak = Math.max(state.peak, ++state.inFlight)
        writes.push({
          value,
          settle: (error) => {
            state.inFlight--
            if (error) {
              reject(error)
              return
            }
            state.saved = value
            resolve()
          }
        })
      })
  )
  publishMobileChatDraftStorage({
    read: async () => state.saved,
    write,
    removeWorkspace: async () => {}
  })
  return { writes, state, write }
}

it('settles an exact copy apart from older and later writes and reloads the complete later draft', async () => {
  vi.useFakeTimers()
  const scope = 'host\0workspace\0tab'
  const { writes, state } = heldWrites()
  const image = (id: string) => ({
    id,
    path: `/tmp/${id}.png`,
    previewUri: `file:///tmp/${id}.png`
  })
  await hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'A')
  const older = persistMobileNativeChatDraft(scope)
  const pendingCopy = appendMobileNativeChatDraft(scope, {
    text: 'Q $review',
    images: [image('q')],
    skills: [{ name: 'review', path: '/q/SKILL.md' }]
  })
  await vi.advanceTimersByTimeAsync(0)
  const copied = readMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, (text) => `${text}\nC`)
  restoreMobileChatDraft(captureMobileChatDraftOwner(scope)!, '$review', [
    { name: 'review', path: '/c/SKILL.md' }
  ])
  updateMobileNativeChatDraftImages(captureMobileChatDraftOwner(scope), (images) => [
    ...images,
    image('c')
  ])
  let laterSettled = false
  const later = persistMobileNativeChatDraft(scope).finally(() => {
    laterSettled = true
  })
  await vi.advanceTimersByTimeAsync(250)
  expect(writes).toHaveLength(1)

  writes[0]!.settle()
  await older
  await vi.advanceTimersByTimeAsync(0)
  expect(JSON.parse(writes[1]!.value!)).toMatchObject({ text: copied.text, skills: copied.skills })
  writes[1]!.settle()
  const receipt = await pendingCopy
  expect(receipt && receipt.valid()).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(laterSettled).toBe(false)
  const complete = readMobileNativeChatDraft(scope)
  expect(JSON.parse(writes[2]!.value!)).toMatchObject({
    text: complete.text,
    skills: [
      { name: 'review', path: '/q/SKILL.md' },
      { name: 'review', path: '/c/SKILL.md' }
    ]
  })
  writes[2]!.settle(new Error('disk full'))
  await expect(later).rejects.toThrow('disk full')
  expect(receipt && receipt.valid()).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(writes).toHaveLength(3)

  const retry = persistMobileNativeChatDraft(scope)
  await vi.advanceTimersByTimeAsync(0)
  writes[3]!.settle()
  await retry
  expect(state.peak).toBe(1)
  resetMobileNativeChatDraftStoreForTests()
  await hydrateMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope)).toMatchObject({
    text: complete.text,
    images: complete.images.map(({ id }) => expect.objectContaining({ id })),
    skills: complete.skills
  })
  editMobileNativeChatDraft(scope, 'D')
  const removed = persistMobileNativeChatDraft(scope)
  await deleteMobileNativeChatDrafts('host', 'workspace')
  await expect(removed).rejects.toThrow('Draft was not saved')
  expect(receipt && receipt.valid()).toBe(false)
})

it.each([100, 1000])(
  'keeps one ordinary slot and three writes for %i edits behind a stalled write, ending in the clear',
  async (edits) => {
    vi.useFakeTimers()
    const scope = `bound-${edits}\0workspace\0tab`
    const { writes, state } = heldWrites()
    await hydrateMobileNativeChatDraft(scope)
    editMobileNativeChatDraft(scope, 'A')
    void persistMobileNativeChatDraft(scope)
    const pendingCopy = appendMobileNativeChatDraft(scope, { text: 'Q', images: [] })
    await vi.advanceTimersByTimeAsync(0)
    editMobileNativeChatDraft(scope, 'typing')
    const owner = captureMobileChatDraftOwner(scope)!
    const slot = owner.ordinary
    for (let index = 0; index < edits; index++) {
      editMobileNativeChatDraft(scope, `typing ${index}`)
      await vi.advanceTimersByTimeAsync(index % 100 === 0 ? 250 : 5)
    }
    expect(owner.ordinary).toBe(slot)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2)
    const typed = readMobileNativeChatDraft(scope)
    clearMobileNativeChatDraftForSend(owner, typed.editGeneration, typed.text)
    for (let index = 0; index < 3; index++) {
      writes[index]!.settle()
      await vi.advanceTimersByTimeAsync(0)
    }
    const receipt = await pendingCopy
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes.map(({ value }) => value && JSON.parse(value).text)).toEqual([
      'A',
      'A\n\nQ',
      null
    ])
    expect(receipt && receipt.valid()).toBe(true)
    expect(state.peak).toBe(1)
  }
)

it('expires public copy authority without releasing blocked physical work or issuing an expired pin', async () => {
  vi.useFakeTimers()
  for (const issued of [false, true]) {
    const scope = `timeout-${issued}\0workspace\0tab`
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = vi.fn(async (_key: string, _value: string | null) => {})
    write.mockImplementationOnce(() => blocked)
    publishMobileChatDraftStorage({
      read: async () => null,
      write,
      removeWorkspace: async () => {}
    })
    await hydrateMobileNativeChatDraft(scope)
    if (!issued) {
      editMobileNativeChatDraft(scope, 'old active')
      void persistMobileNativeChatDraft(scope)
    }
    const copy = appendMobileNativeChatDraft(scope, { text: 'exact copy', images: [] })
    await Promise.resolve()
    const captured = readMobileNativeChatDraft(scope)
    clearMobileNativeChatDraftForSend(
      captureMobileChatDraftOwner(scope),
      captured.editGeneration,
      captured.text
    )
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await copy).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    if (issued) {
      expect(await appendMobileNativeChatDraft(scope, { text: 'another', images: [] })).toBe(false)
    }
    release()
    await persistMobileNativeChatDraft(scope)
    await vi.advanceTimersByTimeAsync(0)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]?.[1]).toBeNull()
  }
})

it('cancels incomplete files on runtime retirement, preserves completed files and disposes its listener', async () => {
  let picked = 'complete-a.txt'
  const releases = new Map<
    string,
    (value: { path: string; name: string; byteLength: number }) => void
  >()
  uploadFile.mockImplementation((_client, file: { name: string }) =>
    file.name.startsWith('complete')
      ? Promise.resolve({ path: `/stored/${file.name}`, name: file.name, byteLength: 1 })
      : new Promise((resolve) => {
          releases.set(file.name, resolve)
        })
  )
  filePicker.mockImplementation(async function* () {
    yield { name: picked, mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
  })
  const storage = () => ({
    read: async () => null,
    write: async () => {},
    removeWorkspace: async () => {}
  })
  publishMobileChatDraftStorage(storage())
  const actualSubscribe = draftStorage.subscribeMobileChatDraftStorage
  const disposed = vi.fn()
  vi.spyOn(draftStorage, 'subscribeMobileChatDraftStorage').mockImplementation((listener) => {
    const dispose = actualSubscribe(listener)
    return () => {
      disposed()
      dispose()
    }
  })
  const client = createFakeRpcClient()
  const messages: NativeChatMessage[] = []
  const showToast = vi.fn()
  let tab = 'a'
  let files: ReturnType<typeof useMobileNativeChatFileAttachments>
  let draft: ReturnType<typeof useMobileNativeChatDrafts>
  let renderer: ReactTestRenderer | undefined
  function Harness() {
    draft = useMobileNativeChatDrafts({
      hostId: 'files',
      worktreeId: 'workspace',
      tabId: tab,
      sessionId: 'session',
      messages,
      transcriptSettled: true
    })
    files = useMobileNativeChatFileAttachments({
      client,
      sessionId: 'session',
      scopeKey: `files\0workspace\0${tab}`,
      enabled: true,
      showToast
    })
    return null
  }
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => files.attachFiles())
    let pendingA: Promise<void>
    picked = 'pending-a.txt'
    await act(async () => {
      pendingA = files.attachFiles()
      await Promise.resolve()
    })
    tab = 'b'
    await act(async () => renderer!.update(createElement(Harness)))
    picked = 'complete-b.txt'
    await act(async () => files.attachFiles())
    let pendingB: Promise<void>
    picked = 'pending-b.txt'
    await act(async () => {
      pendingB = files.attachFiles()
      await Promise.resolve()
    })
    await act(async () => {
      draft.setComposerText('new scope typing')
      publishMobileChatDraftStorage(storage())
    })
    expect(files!.files.map((file) => file.name)).toEqual(['complete-b.txt'])
    expect(draft!.composerText).toBe('new scope typing')
    await act(async () => {
      for (const [name, resolve] of releases) {
        resolve({ name, path: `/stored/${name}`, byteLength: 1 })
      }
      await Promise.all([pendingA!, pendingB!])
    })
    expect(files!.files.map((file) => file.name)).toEqual(['complete-b.txt'])
    expect(showToast.mock.calls).toEqual([
      ["Couldn't upload pending-a.txt"],
      ["Couldn't upload pending-b.txt"]
    ])
    tab = 'a'
    await act(async () => renderer!.update(createElement(Harness)))
    expect(files!.files.map((file) => file.name)).toEqual(['complete-a.txt'])
    act(() => renderer?.unmount())
    renderer = undefined
    expect(disposed).toHaveBeenCalledOnce()
  } finally {
    act(() => renderer?.unmount())
  }
})

it('flushes current native drafting on background and disposes the adapter lifetime listener', async () => {
  installNativeMobileChatDraftStorage()
  const scope = 'background\0workspace\0tab'
  await hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'unsent before background')
  expect(appState.size).toBe(1)
  for (const listener of appState) {
    listener('background')
  }
  await vi.waitFor(() =>
    expect(JSON.parse(disk.get(mobileChatDraftStorageKey(scope))!)).toMatchObject({
      text: 'unsent before background'
    })
  )
  publishMobileChatDraftStorage(null)
  expect(appState.size).toBe(0)
})

it('coalesces visible-scope runtime cleanup and activation into one fresh save', async () => {
  vi.useFakeTimers()
  const scope = 'visible-runtime\0workspace\0tab'
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const oldWrite = vi.fn(async () => {
    await gate
  })
  publishMobileChatDraftStorage({
    read: async () => null,
    write: oldWrite,
    removeWorkspace: async () => {}
  })
  let model: ReturnType<typeof useMobileNativeChatDrafts> | undefined
  function Chat() {
    model = useMobileNativeChatDrafts({
      hostId: 'visible-runtime',
      worktreeId: 'workspace',
      tabId: 'tab',
      sessionId: 'chat',
      messages: [],
      transcriptSettled: true
    })
    return null
  }
  let root: ReactTestRenderer | undefined
  try {
    await act(async () => {
      root = create(createElement(Chat))
    })
    await act(async () => {
      model!.setComposerText('earlier')
      await vi.advanceTimersByTimeAsync(250)
    })
    await act(async () => {
      model!.setComposerText('complete current')
      await vi.advanceTimersByTimeAsync(250)
    })
    const freshWrite = vi.fn(async () => {})
    await act(async () => {
      publishMobileChatDraftStorage({
        read: async () => {
          throw new Error('Known memory must not reread')
        },
        write: freshWrite,
        removeWorkspace: async () => {}
      })
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(freshWrite).toHaveBeenCalledExactlyOnceWith(
      mobileChatDraftStorageKey(scope),
      JSON.stringify({ text: 'complete current', images: [], skills: [] })
    )
    release()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(freshWrite).toHaveBeenCalledOnce()
    expect(model!.composerText).toBe('complete current')
  } finally {
    release()
    await act(async () => root?.unmount())
  }
})
