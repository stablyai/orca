// A structured chat on a paired server keeps pasted images in that server's attachment store, not
// in its temp directory: a temp path has no owner and nothing ever removes it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  readImage: vi.fn(),
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/client-user-data') },
  clipboard: { readImage: mocks.readImage },
  ipcMain: { removeHandler: vi.fn(), handle: mocks.handle },
  nativeImage: { createFromBuffer: vi.fn() }
}))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, selector: string) => ({ id: selector })
}))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => {}),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn(),
  writeRemoteFileToClipboard: vi.fn()
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

function saveHandler(): (...args: unknown[]) => Promise<unknown> {
  const entry = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'clipboard:saveImageAsTempFile'
  )
  if (!entry) {
    throw new Error('save handler was not registered')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.handle was called with this channel's async handler.
  return entry[1] as (...args: unknown[]) => Promise<unknown>
}

const event = {
  sender: {
    id: 17,
    getType: () => 'window',
    getURL: () => 'file:///orca/index.html',
    isDestroyed: () => false
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setTrustedClipboardRendererWebContentsId(17)
  mocks.readImage.mockReturnValue({
    getSize: () => ({ height: 1, width: 1 }),
    isEmpty: () => false,
    toPNG: () => Buffer.from('png')
  })
  mocks.callRuntimeEnvironment.mockImplementation(async (_userData, _env, method: string) => {
    if (method === 'agentSessionAttachment.uploadStart') {
      return { ok: true, result: { uploadId: 'upload-1' } }
    }
    if (method === 'agentSessionAttachment.uploadAppend') {
      return { ok: true, result: { receivedBytes: 3 } }
    }
    if (method === 'agentSessionAttachment.uploadCommit') {
      return {
        ok: true,
        result: { path: '/srv/agent-session-attachments/s/upload-1/p.png', name: 'p.png' }
      }
    }
    throw new Error(`unexpected method: ${method}`)
  })
})

describe('clipboard:saveImageAsTempFile for a structured chat on a paired server', () => {
  it("stores the image in the chat's attachment store, pinned to the pairing and server", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the image save path never reads the store.
    registerClipboardHandlers({} as never)

    await expect(
      saveHandler()(event, {
        runtimeEnvironmentId: 'remote-host-1',
        agentSessionAttachment: {
          sessionId: 'session-1',
          expectedEnvironmentPairingRevision: 7,
          expectedEnvironmentRuntimeId: 'runtime-a'
        }
      })
    ).resolves.toBe('/srv/agent-session-attachments/s/upload-1/p.png')

    const methods = mocks.callRuntimeEnvironment.mock.calls.map((call) => call[2])
    expect(methods).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit'
    ])
    expect(mocks.callRuntimeEnvironment.mock.calls[0][3]).toMatchObject({
      sessionId: 'session-1',
      name: expect.stringMatching(/^orca-paste-.+\.png$/),
      byteLength: 3
    })
    for (const call of mocks.callRuntimeEnvironment.mock.calls) {
      expect(call[5]).toBe(7)
      expect(call[7]).toMatchObject({ expectedEnvironmentRuntimeId: 'runtime-a' })
    }
  })

  it('keeps the server temp directory for a paste that names no chat', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({ ok: true, result: { uploadId: 'u' } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the image save path never reads the store.
    registerClipboardHandlers({} as never)
    await saveHandler()(event, { runtimeEnvironmentId: 'remote-host-1' }).catch(() => {})
    expect(mocks.callRuntimeEnvironment.mock.calls[0][2]).toBe('clipboard.startImageUpload')
  })
})
