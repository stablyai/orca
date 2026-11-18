import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { ipcMain: new Emitter() }
})
import {
  installNativeUnloadCoordinator,
  reloadWithRendererCheckpoint,
  replacePendingReloadWithClose
} from './native-unload-coordinator'

function fixture() {
  const frame = { send: vi.fn() }
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    isCrashed: () => false,
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), { webContents: contents })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements the window events and webContents members the coordinator uses.
  installNativeUnloadCoordinator(window as unknown as BrowserWindow)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements the webContents members the coordinator uses.
  const webContents = contents as unknown as WebContents
  const reply = (ok: boolean, senderFrame: unknown = frame): void => {
    const requestId = frame.send.mock.calls.findLast(
      ([channel]) => channel === 'app:prepare-native-unload'
    )?.[1]
    ipcMain.emit('app:native-unload-prepared', { sender: contents, senderFrame }, { requestId, ok })
  }
  return {
    contents,
    frame,
    reply,
    reload: (ignoreCache = false) => reloadWithRendererCheckpoint(webContents, ignoreCache),
    replaceWithClose: () => replacePendingReloadWithClose(webContents)
  }
}

beforeEach(() => ipcMain.removeAllListeners())

describe('native reload checkpoint', () => {
  it('reloads once, only after the owning document reports its durable save', async () => {
    const { contents, reply, reload } = fixture()
    const first = reload()
    const second = reload()
    reply(true, {})
    expect(contents.reload).not.toHaveBeenCalled()
    reply(true)
    await Promise.all([first, second])
    expect(contents.reload).toHaveBeenCalledOnce()
  })

  it('keeps the document when its save fails', async () => {
    const { contents, reply, reload } = fixture()
    const result = reload()
    reply(false)
    await expect(result).rejects.toThrow('could not be saved')
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('does not reload a document that replaced the one asked to save', async () => {
    const { contents, reply, reload } = fixture()
    const result = reload()
    contents.emit('did-frame-navigate', {}, 'file:///replacement.html', 200, 'OK', true)
    reply(true)
    await result
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('lets a close requested mid-checkpoint wait for the verdict and replace the reload', async () => {
    const { contents, frame, reply, reload, replaceWithClose } = fixture()
    const result = reload()
    let closeMayProceed = false
    const close = replaceWithClose()?.then(() => {
      closeMayProceed = true
    })
    await Promise.resolve()
    expect(closeMayProceed).toBe(false)
    reply(true)
    await Promise.all([result, close])
    expect(closeMayProceed).toBe(true)
    expect(contents.reload).not.toHaveBeenCalled()
    // The page suspended its unload guards for the reload; the close must find them restored.
    expect(frame.send).toHaveBeenLastCalledWith('app:native-unload-canceled', expect.any(String))
  })
})
