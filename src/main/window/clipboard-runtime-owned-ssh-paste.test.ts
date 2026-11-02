// #17679: nested Remote Server → SSH paste must resolve on the runtime; this process owns no SSH filesystem.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const { handleMock, callRuntimeEnvironmentMock, fsWriteFileMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  callRuntimeEnvironmentMock: vi.fn(),
  fsWriteFileMock: vi.fn()
}))

const PNG = Buffer.from([0, 1, 2, 3])

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  clipboard: {
    availableFormats: () => ['image/png'],
    readImage: () => ({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => PNG
    }),
    readText: vi.fn(),
    readBuffer: vi.fn(() => Buffer.alloc(0)),
    writeText: vi.fn(),
    writeImage: vi.fn(),
    writeBuffer: vi.fn()
  },
  ipcMain: { removeHandler: vi.fn(), handle: handleMock },
  nativeImage: { createFromBuffer: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  opendir: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  rm: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  writeFile: fsWriteFileMock,
  default: { writeFile: fsWriteFileMock, mkdir: vi.fn() }
}))
vi.mock('../ipc/filesystem/filesystem-auth', () => ({
  PATH_ACCESS_DENIED_MESSAGE: 'denied',
  resolveAuthorizedPath: vi.fn()
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'

type SaveImageHandler = (event: unknown, args?: unknown) => Promise<string | null>

const RUNTIME_ID = 'ubuntu-server'
const RUNTIME_SSH_TARGET = 'jetson'
const CLIENT_SSH_TARGET = 'client-dialed'

const rendererEvent = {
  sender: {
    id: 1,
    getType: () => 'window',
    getURL: () => 'file:///orca/index.html',
    isDestroyed: () => false
  }
}

function saveImageHandler(): SaveImageHandler {
  handleMock.mockClear()
  registerClipboardHandlers({} as never)
  const call = handleMock.mock.calls.find((c) => c[0] === 'clipboard:saveImageAsTempFile')
  if (!call) {
    throw new Error('clipboard:saveImageAsTempFile not registered')
  }
  return call[1] as SaveImageHandler
}

function mockRuntimeUpload(
  overrides: Record<string, { ok: boolean; result?: unknown; error?: unknown }> = {}
): void {
  callRuntimeEnvironmentMock.mockImplementation(async (_userData, _env, method) => {
    if (method in overrides) {
      return { ...overrides[method], _meta: { runtimeId: 'r' } }
    }
    switch (method) {
      case 'clipboard.startImageUpload':
        return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'r' } }
      case 'clipboard.appendImageUploadChunk':
        return { ok: true, result: { receivedBase64Length: 8 }, _meta: { runtimeId: 'r' } }
      case 'clipboard.commitImageUpload':
        return { ok: true, result: '/tmp/on-runtime-target.png', _meta: { runtimeId: 'r' } }
      case 'clipboard.abortImageUpload':
        return { ok: true, result: { aborted: true }, _meta: { runtimeId: 'r' } }
      default:
        throw new Error(`unexpected runtime method ${method}`)
    }
  })
}

function runtimeCall(method: string): unknown[] | undefined {
  return callRuntimeEnvironmentMock.mock.calls.find((c) => c[2] === method)
}

describe('clipboard image paste for a runtime-owned SSH workspace', () => {
  beforeEach(() => {
    installFakeAppEnvironment({ getPath: () => '/tmp' })
    setTrustedClipboardRendererWebContentsId(rendererEvent.sender.id)
    callRuntimeEnvironmentMock.mockReset()
    fsWriteFileMock.mockReset()
  })

  it('sends the paste to the runtime and names the runtime SSH target, never this registry', async () => {
    mockRuntimeUpload()
    const nestedArgs = { connectionId: RUNTIME_SSH_TARGET, runtimeEnvironmentId: RUNTIME_ID }

    await expect(saveImageHandler()(rendererEvent, nestedArgs)).resolves.toBe(
      '/tmp/on-runtime-target.png'
    )

    const start = runtimeCall('clipboard.startImageUpload')
    expect(start?.[1]).toBe(nestedArgs.runtimeEnvironmentId)
    expect(start?.[3]).toEqual({
      expectedBase64Length: PNG.toString('base64').length,
      connectionId: nestedArgs.connectionId
    })
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('names the runtime SSH target on the single-frame fallback for older runtimes', async () => {
    mockRuntimeUpload({
      'clipboard.startImageUpload': {
        ok: false,
        error: { code: 'method_not_found', message: 'no such method' }
      },
      'clipboard.saveImageAsTempFile': { ok: true, result: '/tmp/on-runtime-target.png' }
    })
    const nestedArgs = { connectionId: RUNTIME_SSH_TARGET, runtimeEnvironmentId: RUNTIME_ID }

    await expect(saveImageHandler()(rendererEvent, nestedArgs)).resolves.toBe(
      '/tmp/on-runtime-target.png'
    )

    expect(runtimeCall('clipboard.saveImageAsTempFile')?.[3]).toEqual({
      contentBase64: PNG.toString('base64'),
      connectionId: nestedArgs.connectionId
    })
  })

  it('surfaces the runtime verdict instead of the local Reconnect advice when the runtime fails', async () => {
    mockRuntimeUpload({
      'clipboard.startImageUpload': {
        ok: false,
        error: { code: 'runtime_error', message: 'Unknown environment' }
      }
    })

    await expect(
      saveImageHandler()(rendererEvent, {
        connectionId: RUNTIME_SSH_TARGET,
        runtimeEnvironmentId: 'missing-env'
      })
    ).rejects.toThrow('Unknown environment')
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('reports the dropped-connection verdict for a client-dialed SSH target', async () => {
    await expect(
      saveImageHandler()(rendererEvent, { connectionId: CLIENT_SSH_TARGET })
    ).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })
})
