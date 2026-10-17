import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handle,
  removeHandler,
  stage,
  release,
  releaseOwner,
  sweepExpired,
  readImage,
  readNativeImage
} = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  stage: vi.fn(),
  release: vi.fn(),
  releaseOwner: vi.fn(),
  sweepExpired: vi.fn(),
  readImage: vi.fn(),
  readNativeImage: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/profile' },
  ipcMain: { handle, removeHandler },
  clipboard: {}
}))
vi.mock('./clipboard-image-import-source', () => ({ readClipboardImageForImport: readImage }))
vi.mock('./clipboard-native-image', () => ({ readClipboardNativeImage: readNativeImage }))
vi.mock('./clipboard-image-import-staging', () => ({
  ClipboardImageImportStaging: class {
    stage = stage
    release = release
    releaseOwner = releaseOwner
    sweepExpired = sweepExpired
  }
}))

function handler(channel: string) {
  const registered = handle.mock.calls.find(([name]) => name === channel)
  if (!registered) {
    throw new Error(`Missing handler: ${channel}`)
  }
  return registered[1]
}

function sender(id = 17) {
  return Object.assign(new EventEmitter(), { id })
}

describe('clipboard image import IPC lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.resetModules()
    vi.resetAllMocks()
    readImage.mockReturnValue(Buffer.from('PNG'))
    stage.mockImplementation(async () => ({
      handle: 'snapshot',
      path: '/staging/pasted-image.png'
    }))
    release.mockResolvedValue(true)
    releaseOwner.mockResolvedValue(undefined)
    sweepExpired.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function register(assertTrustedSender = vi.fn()) {
    const { registerClipboardImageImportHandlers } = await import('./clipboard-image-import-ipc')
    registerClipboardImageImportHandlers(assertTrustedSender)
    return registerClipboardImageImportHandlers
  }

  it('captures the image before yielding and binds release to the invoking sender', async () => {
    const authorize = vi.fn()
    await register(authorize)
    const event = { sender: sender() }
    const pending = handler('clipboard:stageImageForImport')(event)
    expect(authorize).toHaveBeenCalledWith(event)
    expect(readImage).toHaveBeenCalledOnce()
    expect(readImage).toHaveBeenCalledWith({}, process.platform, readNativeImage)
    expect(stage).toHaveBeenCalledWith(17, Buffer.from('PNG'), expect.any(AbortSignal))
    expect(await pending).toEqual({ handle: 'snapshot', path: '/staging/pasted-image.png' })
    await handler('clipboard:releaseImageImport')(event, 'snapshot')
    expect(release).toHaveBeenCalledWith(17, 'snapshot')
  })

  it('authorizes before reading pixels or releasing a handle', async () => {
    await register(
      vi.fn(() => {
        throw new Error('Unauthorized')
      })
    )
    expect(() => handler('clipboard:stageImageForImport')({ sender: sender() })).toThrow(
      'Unauthorized'
    )
    expect(() => handler('clipboard:releaseImageImport')({ sender: sender() }, 'snapshot')).toThrow(
      'Unauthorized'
    )
    expect(readImage).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('does not allocate staging or lifecycle listeners when no image is available', async () => {
    await register()
    readImage.mockReturnValue(null)
    const owner = sender()
    expect(handler('clipboard:stageImageForImport')({ sender: owner })).toBeNull()
    expect(owner.eventNames()).toEqual([])
    expect(stage).not.toHaveBeenCalled()
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])(
    'cancels pending writes and releases completed snapshots on %s',
    async (eventName) => {
      await register()
      const owner = sender()
      await handler('clipboard:stageImageForImport')({ sender: owner })
      const signal: AbortSignal = stage.mock.calls[0][2]
      expect(signal.aborted).toBe(false)
      owner.emit(eventName, {}, 'file:///orca/index.html', false, true)
      expect(signal.aborted).toBe(true)
      expect(releaseOwner).toHaveBeenCalledExactlyOnceWith(17)
      expect(owner.eventNames()).toEqual([])
    }
  )

  it('ignores subframe and same-document navigation and can capture a fresh renderer generation', async () => {
    await register()
    const owner = sender()
    await handler('clipboard:stageImageForImport')({ sender: owner })
    const oldSignal: AbortSignal = stage.mock.calls[0][2]
    owner.emit('did-start-navigation', {}, 'about:blank', false, false)
    owner.emit('did-start-navigation', {}, 'file:///orca/index.html#tree', true, true)
    expect(oldSignal.aborted).toBe(false)
    owner.emit('render-process-gone')
    await handler('clipboard:stageImageForImport')({ sender: owner })
    const newSignal: AbortSignal = stage.mock.calls[1][2]
    expect(oldSignal.aborted).toBe(true)
    expect(newSignal.aborted).toBe(false)
    expect(newSignal).not.toBe(oldSignal)
  })

  it('shares one set of lifecycle listeners across pastes and handler re-registration', async () => {
    const registerAgain = await register()
    const owner = sender()
    for (let i = 0; i < 15; i++) {
      await handler('clipboard:stageImageForImport')({ sender: owner })
    }
    registerAgain(vi.fn())
    await handler('clipboard:stageImageForImport')({ sender: owner })
    for (const name of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
      expect(owner.listenerCount(name)).toBe(1)
    }
    expect(removeHandler).toHaveBeenCalledWith('clipboard:stageImageForImport')
    expect(removeHandler).toHaveBeenCalledWith('clipboard:releaseImageImport')
  })

  it('keeps another window alive when an owner disappears', async () => {
    await register()
    const first = sender(17)
    const second = sender(18)
    await handler('clipboard:stageImageForImport')({ sender: first })
    await handler('clipboard:stageImageForImport')({ sender: second })
    first.emit('destroyed')
    const secondSignal: AbortSignal = stage.mock.calls[1][2]
    expect(secondSignal.aborted).toBe(false)
    expect(releaseOwner).toHaveBeenCalledExactlyOnceWith(17)
  })

  it('sweeps crash leftovers periodically without polling the clipboard or duplicating timers', async () => {
    const registerAgain = await register()
    registerAgain(vi.fn())
    expect(sweepExpired).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(sweepExpired).toHaveBeenCalledTimes(3)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('logs sweep failures without leaving an unhandled rejection or breaking capture', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    sweepExpired.mockRejectedValueOnce(new Error('disk unavailable'))
    await register()
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    await expect(
      handler('clipboard:stageImageForImport')({ sender: sender() })
    ).resolves.toMatchObject({ handle: 'snapshot' })
  })
})
