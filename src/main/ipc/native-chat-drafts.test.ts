import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SidecarSnapshotFile from '../sidecar-snapshot-file'

const { handlers, listeners, ipcMainMock, isTrustedUIRendererMock } = vi.hoisted(() => {
  const handlerMap = new Map<string, (...args: unknown[]) => unknown>()
  const listenerMap = new Map<string, (...args: unknown[]) => void>()
  return {
    handlers: handlerMap,
    listeners: listenerMap,
    ipcMainMock: {
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlerMap.set(channel, fn),
      on: (channel: string, fn: (...args: unknown[]) => void) => listenerMap.set(channel, fn)
    },
    isTrustedUIRendererMock: vi.fn(() => true)
  }
})

const sidecar = vi.hoisted(() => ({ removeSidecarSnapshot: vi.fn() }))

vi.mock('../sidecar-snapshot-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SidecarSnapshotFile>()
  sidecar.removeSidecarSnapshot.mockImplementation(actual.removeSidecarSnapshot)
  return { ...actual, removeSidecarSnapshot: sidecar.removeSidecarSnapshot }
})
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('./ui', () => ({ isTrustedUIRenderer: isTrustedUIRendererMock }))

import { drainNativeChatDrafts, registerNativeChatDraftHandlers } from './native-chat-drafts'

const trusted = { sender: { id: 1 } }
const draft = { text: 'hello', attachments: [] }
let tempRoot = ''
let root = ''

function invoke(channel: string, event: unknown, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(event, args)
}

function loadSync(event: { sender: { id: number } }): unknown {
  const reply: { sender: { id: number }; returnValue?: unknown } = { ...event }
  listeners.get('nativeChat:drafts:loadSync')?.(reply)
  return reply.returnValue
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-native-chat-draft-ipc-'))
  root = join(tempRoot, 'native-chat-drafts')
  isTrustedUIRendererMock.mockReturnValue(true)
  registerNativeChatDraftHandlers(root)
})

afterEach(async () => {
  await drainNativeChatDrafts()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('native chat draft IPC', () => {
  it('saves, loads and clears a draft for the app window', async () => {
    await expect(
      invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft })
    ).resolves.toBe('persisted')
    await expect(invoke('nativeChat:drafts:load', trusted)).resolves.toEqual([
      { scopeKey: 'session:s1', draft }
    ])
    expect(loadSync(trusted)).toEqual([{ scopeKey: 'session:s1', draft }])

    await invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft: null })
    expect(await readdir(root)).toEqual([])
  })

  it('refuses every other renderer', async () => {
    await invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft })
    isTrustedUIRendererMock.mockReturnValue(false)
    const other = { sender: { id: 2 } }

    expect(await invoke('nativeChat:drafts:write', other, { scopeKey: 'session:s2', draft })).toBe(
      'failed'
    )
    expect(
      await invoke('nativeChat:drafts:write', other, { scopeKey: 'session:s1', draft: null })
    ).toBe('failed')
    expect(await invoke('nativeChat:drafts:load', other)).toEqual([])
    expect(loadSync(other)).toEqual([])
    isTrustedUIRendererMock.mockReturnValue(true)
    expect(await invoke('nativeChat:drafts:load', trusted)).toEqual([
      { scopeKey: 'session:s1', draft }
    ])
  })

  it('refuses a write without a chat', async () => {
    expect(await invoke('nativeChat:drafts:write', trusted, { draft })).toBe('failed')
    expect(await invoke('nativeChat:drafts:write', trusted, null)).toBe('failed')
  })

  // macOS keeps Orca running with no window; reopening one registers the handlers again.
  it('keeps the same store when the window is reopened, so a failed clear is still owed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft })
    sidecar.removeSidecarSnapshot.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    )
    expect(
      await invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft: null })
    ).toBe('failed')

    registerNativeChatDraftHandlers(root)

    expect(await invoke('nativeChat:drafts:load', trusted)).toEqual([])
    await drainNativeChatDrafts()
    expect(await readdir(root)).toEqual([])
  })

  it('lets a draft written just before quitting land before the app exits', async () => {
    void invoke('nativeChat:drafts:write', trusted, { scopeKey: 'session:s1', draft })

    await drainNativeChatDrafts()

    expect((await readdir(root)).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  })
})
