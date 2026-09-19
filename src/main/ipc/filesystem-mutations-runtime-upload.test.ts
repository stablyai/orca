import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, streamMock, sweepMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  streamMock: vi.fn(),
  sweepMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  app: { getPath: () => '/user-data' }
}))
vi.mock('./runtime-upload-file-stream', () => ({
  streamExternalFileToRuntime: streamMock
}))
vi.mock('./runtime-upload-temp-sweep', () => ({
  sweepAbandonedRuntimeUploadTempPath: sweepMock
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, selector: string) => ({
    id: selector === 'env-alias' ? 'env-1' : selector
  })
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { RENDERER_GONE_MESSAGE } from './renderer-lifetime-abort'

const request = {
  environmentId: 'env-1',
  sourceRootPath: '/drop/file.bin',
  entryRelativePath: '',
  expected: { byteLength: 1, inode: 1, deviceId: 1, modifiedAtMs: 1 },
  worktree: 'wt-1',
  relativePath: '.file.bin.orca-upload-x',
  expectedEnvironmentPairingRevision: 3,
  expectedEnvironmentRuntimeId: 'rt-1'
}

function fakeSender(): EventEmitter {
  return new EventEmitter()
}

function listenerCount(sender: EventEmitter): number {
  return ['destroyed', 'render-process-gone', 'did-navigate'].reduce(
    (total, name) => total + sender.listenerCount(name),
    0
  )
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  streamMock.mockReset()
  sweepMock.mockReset()
  sweepMock.mockResolvedValue(undefined)
  handleMock.mockImplementation((channel: string, handler: never) => {
    handlers.set(channel, handler)
  })
  registerFilesystemMutationHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload handler under test never reads the store; registration only needs a Store-shaped value.
    { getRepos: () => [], getSettings: () => ({ workspaceDir: '/workspace' }) } as never
  )
})

function invoke(sender: EventEmitter): Promise<unknown> {
  return handlers.get('fs:uploadExternalFileToRuntime')!({ sender }, request)
}

describe('fs:uploadExternalFileToRuntime', () => {
  it('streams with the user data path and a live signal, and leaves no listeners behind', async () => {
    const sender = fakeSender()
    streamMock.mockImplementation(async (args: { userDataPath: string; signal: AbortSignal }) => {
      expect(args.userDataPath).toBe('/user-data')
      expect(args.signal.aborted).toBe(false)
      expect(listenerCount(sender)).toBe(3)
      return { byteLength: 42 }
    })

    await expect(invoke(sender)).resolves.toEqual({ byteLength: 42 })

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining(request))
    expect(sweepMock).not.toHaveBeenCalled()
    expect(listenerCount(sender)).toBe(0)
  })

  it('resolves the selector to the environment id before streaming and sweeping', async () => {
    const sender = fakeSender()
    streamMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          sender.emit('destroyed')
        })
    )

    await expect(
      handlers.get('fs:uploadExternalFileToRuntime')!(
        { sender },
        { ...request, environmentId: 'env-alias' }
      )
    ).rejects.toThrow(RENDERER_GONE_MESSAGE)

    expect(streamMock).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'env-1' }))
    expect(sweepMock).toHaveBeenCalledWith('/user-data', { ...request, environmentId: 'env-1' })
  })

  it('aborts, sweeps the temp path, and rethrows when the renderer is destroyed mid-stream', async () => {
    const sender = fakeSender()
    streamMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          sender.emit('destroyed')
        })
    )

    await expect(invoke(sender)).rejects.toThrow(RENDERER_GONE_MESSAGE)

    expect(sweepMock).toHaveBeenCalledTimes(1)
    expect(sweepMock).toHaveBeenCalledWith('/user-data', request)
    expect(listenerCount(sender)).toBe(0)
  })

  it('aborts once a reload commits, not on a blocked navigation or an in-app route change', async () => {
    const sender = fakeSender()
    let observed: AbortSignal | undefined
    streamMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          observed = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
          sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
          sender.emit('will-navigate', { defaultPrevented: true }, 'https://example.invalid/')
          queueMicrotask(() => {
            expect(signal.aborted).toBe(false)
            sender.emit('did-navigate', 'file:///app/index.html', 200, 'OK')
            resolve({ byteLength: 0 })
          })
        })
    )

    await expect(invoke(sender)).rejects.toThrow(RENDERER_GONE_MESSAGE)
    expect(observed?.aborted).toBe(true)
    expect(sweepMock).toHaveBeenCalledTimes(1)
  })

  it('does not sweep when the stream fails while the renderer is still alive', async () => {
    const sender = fakeSender()
    streamMock.mockRejectedValue(new Error("File changed since it was staged: 'file.bin'"))

    await expect(invoke(sender)).rejects.toThrow("File changed since it was staged: 'file.bin'")

    expect(sweepMock).not.toHaveBeenCalled()
    expect(listenerCount(sender)).toBe(0)
  })

  it('still rethrows the stream error if the sweep itself throws', async () => {
    const sender = fakeSender()
    sweepMock.mockRejectedValue(new Error('sweep exploded'))
    streamMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          sender.emit('render-process-gone')
        })
    )

    // Why: the sweep contract is "never rejects"; if it ever did, this documents
    // that the handler would surface the sweep error instead of the upload's.
    await expect(invoke(sender)).rejects.toThrow('sweep exploded')
    expect(listenerCount(sender)).toBe(0)
  })
})
