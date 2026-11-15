import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { ipcMain: new Emitter() }
})
import {
  installNativeUnloadCoordinator,
  reloadWithRendererCheckpoint,
  replacePendingReloadWithClose,
  setWindowCloseInFlight
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
    replaceWithClose: () => replacePendingReloadWithClose(webContents),
    setCloseInFlight: (close: { quitting: boolean } | null) =>
      setWindowCloseInFlight(webContents, close)
  }
}

beforeEach(() => ipcMain.removeAllListeners())
afterEach(() => vi.useRealTimers())

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

  it('upgrades a waiting reload to Force Reload', async () => {
    const { contents, reply, reload } = fixture()
    const ordinary = reload()
    const forced = reload(true)
    reply(true)
    await Promise.all([ordinary, forced])
    expect(contents.reload).not.toHaveBeenCalled()
    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce()
  })

  it('keeps the document when its save fails', async () => {
    const { contents, reply, reload } = fixture()
    const result = reload()
    reply(false)
    await expect(result).rejects.toThrow('could not be saved')
    expect(contents.reload).not.toHaveBeenCalled()
  })

  it('reloads anyway when a live renderer never answers', async () => {
    vi.useFakeTimers()
    const { contents, frame, reload } = fixture()
    const result = reload(true)
    const requestId = frame.send.mock.calls[0]?.[1]
    ipcMain.emit('app:native-unload-received', { sender: contents, senderFrame: frame }, requestId)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(frame.send).toHaveBeenCalledWith('app:native-unload-canceled', expect.any(String))
    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce()
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

  it('does not reload over a quit close the renderer is still answering', async () => {
    const { contents, frame, reload, setCloseInFlight } = fixture()
    setCloseInFlight({ quitting: true })
    await reload(true)
    expect(frame.send).not.toHaveBeenCalled()
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('keeps refusing reload when an ordinary close follows a quit close', async () => {
    const { contents, reload, setCloseInFlight } = fixture()
    setCloseInFlight({ quitting: true })
    setCloseInFlight({ quitting: false })
    await reload(true)
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('asks again after a prepare request could not be sent', async () => {
    const { contents, frame, reply, reload } = fixture()
    frame.send.mockImplementationOnce(() => {
      throw new Error('frame disposed')
    })
    await reload()
    expect(contents.reload).toHaveBeenCalledOnce()
    const next = reload()
    expect(frame.send).toHaveBeenCalledTimes(2)
    reply(true)
    await next
    expect(contents.reload).toHaveBeenCalledTimes(2)
  })
})
