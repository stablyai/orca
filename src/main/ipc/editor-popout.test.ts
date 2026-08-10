import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorPopoutOpenRequest } from '../../shared/editor-popout'

const {
  handlers,
  mainSender,
  popoutSender,
  openEditorPopoutMock,
  getRequestMock,
  isEditorPopoutRendererMock,
  reportReadyMock,
  setDirtyMock,
  completeSaveAndCloseMock,
  getTrustedRendererMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>(),
  mainSender: { id: 1 },
  popoutSender: { id: 2 },
  openEditorPopoutMock: vi.fn(),
  getRequestMock: vi.fn(),
  isEditorPopoutRendererMock: vi.fn(),
  reportReadyMock: vi.fn(),
  setDirtyMock: vi.fn(),
  completeSaveAndCloseMock: vi.fn(),
  getTrustedRendererMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
}))

vi.mock('../window/editor-popout-window', () => ({
  openEditorPopout: openEditorPopoutMock,
  getEditorPopoutRequest: getRequestMock,
  isEditorPopoutRenderer: isEditorPopoutRendererMock,
  reportEditorPopoutReady: reportReadyMock,
  setEditorPopoutDirty: setDirtyMock,
  completeEditorPopoutSaveAndClose: completeSaveAndCloseMock
}))

vi.mock('./ui', () => ({
  getTrustedUIRendererWebContents: getTrustedRendererMock
}))

import { registerEditorPopoutHandlers } from './editor-popout'

const request = {
  document: {
    id: '/workspace/note.md',
    filePath: '/workspace/note.md',
    relativePath: 'note.md',
    worktreeId: 'repo:main',
    language: 'markdown'
  },
  content: '# Draft\n',
  savedContent: '# Saved\n',
  viewMode: 'source',
  showFrontmatter: true,
  operationContext: {
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'repo:main',
    worktreePath: '/workspace',
    expectedExecutionHostId: 'local'
  }
} satisfies EditorPopoutOpenRequest

describe('registerEditorPopoutHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    getTrustedRendererMock.mockReturnValue(mainSender)
    isEditorPopoutRendererMock.mockImplementation((sender) => sender === popoutSender)
    getRequestMock.mockReturnValue(request)
    openEditorPopoutMock.mockResolvedValue({ created: true })
    registerEditorPopoutHandlers()
  })

  it('opens only from the primary trusted renderer with an admitted request', async () => {
    await expect(
      handlers.get('editorPopout:open')!({ sender: { id: 99 } }, request)
    ).resolves.toEqual({
      created: false
    })
    await expect(
      handlers.get('editorPopout:open')!({ sender: mainSender }, { nope: true })
    ).resolves.toEqual({ created: false })
    await expect(
      handlers.get('editorPopout:open')!({ sender: mainSender }, request)
    ).resolves.toEqual({ created: true })

    expect(openEditorPopoutMock).toHaveBeenCalledOnce()
    expect(openEditorPopoutMock).toHaveBeenCalledWith(request)
  })

  it('serves state and lifecycle updates only to an editor popout renderer', () => {
    expect(handlers.get('editorPopout:getState')!({ sender: mainSender })).toBeNull()
    expect(handlers.get('editorPopout:getState')!({ sender: popoutSender })).toEqual(request)

    handlers.get('editorPopout:setDirty')!({ sender: mainSender }, true)
    handlers.get('editorPopout:ready')!({ sender: popoutSender })
    handlers.get('editorPopout:setDirty')!({ sender: popoutSender }, true)
    handlers.get('editorPopout:completeSaveAndClose')!({ sender: popoutSender }, true)
    handlers.get('editorPopout:completeSaveAndClose')!({ sender: popoutSender }, 'yes')

    expect(setDirtyMock).toHaveBeenCalledOnce()
    expect(reportReadyMock).toHaveBeenCalledOnce()
    expect(setDirtyMock).toHaveBeenCalledWith(popoutSender, true)
    expect(completeSaveAndCloseMock).toHaveBeenCalledOnce()
    expect(completeSaveAndCloseMock).toHaveBeenCalledWith(popoutSender, true)
  })
})
