// Structured chats own pasted images in their host attachment store; temp paths cannot distinguish sent from abandoned pastes.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  readImage: vi.fn(),
  createFromBuffer: vi.fn(),
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/client-user-data') },
  clipboard: {
    readImage: mocks.readImage,
    availableFormats: () => ['image/png'],
    readBuffer: () => Buffer.alloc(0)
  },
  ipcMain: { removeHandler: vi.fn(), handle: mocks.handle },
  nativeImage: { createFromBuffer: mocks.createFromBuffer }
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, selector: string) => ({ id: selector })
}))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(async () => {}),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn()
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

describe('clipboard:saveImageAsTempFile for a local structured chat', () => {
  it('stores the supplied marked image without reading the system clipboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-commented-image-'))
    try {
      const store = new AgentSessionAttachmentStore(root, { hasSession: () => false })
      mocks.createFromBuffer.mockReturnValue({
        getSize: () => ({ width: 1200, height: 800 }),
        isEmpty: () => false,
        toPNG: () => Buffer.from('marked-image')
      })
      registerClipboardHandlers({} as never, { localChatAttachmentStore: async () => store })
      const saved = await saveHandler()(event, {
        forNativeChatDraft: true,
        forStructuredChat: true,
        imageDataUrl: 'data:image/png;base64,bWFya2VkLWltYWdl'
      })
      expect(await readFile(String(saved), 'utf8')).toBe('marked-image')
      expect(mocks.createFromBuffer).toHaveBeenCalledWith(Buffer.from('marked-image'))
      expect(mocks.readImage).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("stores the image in this machine's attachment store, where a send can claim it", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-local-paste-store-'))
    try {
      const store = new AgentSessionAttachmentStore(root, { hasSession: () => false })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the image save path never reads the store.
      registerClipboardHandlers({} as never, { localChatAttachmentStore: async () => store })

      const saved = await saveHandler()(event, {
        forNativeChatDraft: true,
        forStructuredChat: true
      })

      expect(saved).toEqual(
        expect.stringMatching(
          /[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]orca-paste-.+\.png$/
        )
      )
      expect(String(saved).startsWith(root)).toBe(true)
      expect(await readFile(String(saved), 'utf8')).toBe('png')
      expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
