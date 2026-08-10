import { describe, expect, it, vi } from 'vitest'
import type { EditorPopoutOpenRequest } from '../shared/editor-popout'
import { createEditorPopoutPreloadApi } from './editor-popout-api'

const request = {
  document: {
    id: '/workspace/note.md',
    filePath: '/workspace/note.md',
    relativePath: 'note.md',
    worktreeId: 'repo:main',
    language: 'markdown',
    runtimeEnvironmentId: 'runtime-1'
  },
  content: '# Draft\n',
  savedContent: '# Saved\n',
  viewMode: 'source',
  showFrontmatter: true,
  operationContext: {
    settings: { activeRuntimeEnvironmentId: 'runtime-1' },
    worktreeId: 'repo:main',
    worktreePath: '/workspace',
    expectedExecutionHostId: 'local',
    expectedEnvironmentPairingRevision: 11
  }
} satisfies EditorPopoutOpenRequest

describe('createEditorPopoutPreloadApi', () => {
  it('exposes only document-scoped editor, filesystem, and runtime APIs', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ ok: true })
    const send = vi.fn()
    const sendSync = vi.fn().mockReturnValue({ theme: 'dark' })
    const api = createEditorPopoutPreloadApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
      send,
      sendSync
    } as never)

    await api.editorPopout.getState()
    await api.editorPopout.reportReady()

    expect(Object.keys(api).sort()).toEqual([
      'editorPopout',
      'fs',
      'runtimeEnvironments',
      'settings',
      'shell',
      'ui'
    ])
    expect(api).not.toHaveProperty('terminal')
    expect(api.fs).not.toHaveProperty('authorizeExternalPath')
    expect(api.settings.getSync()).toEqual({ theme: 'dark' })
    await api.ui.writeClipboardText('copied')
    await expect(api.ui.readClipboardText()).resolves.toBe('')
    await expect(api.ui.saveClipboardImageAsTempFile()).resolves.toBeNull()
    api.ui.setMarkdownEditorFocused(true)
    await expect(api.shell.pathExists('/private/secret')).resolves.toBe(false)
    await expect(api.shell.openFileUri('file:///private/secret')).resolves.toBeUndefined()
    await expect(api.shell.pickImage()).resolves.toBeNull()
    expect(send).toHaveBeenCalledWith('ui:setMarkdownEditorFocused', true)
    expect(invoke).toHaveBeenCalledWith('clipboard:writeText', 'copied')
    expect(invoke).toHaveBeenCalledWith('editorPopout:ready')
    const invokedChannels = invoke.mock.calls.map(([channel]) => channel)
    expect(invokedChannels).not.toContain('clipboard:readText')
    expect(invokedChannels).not.toContain('clipboard:saveImageAsTempFile')
    expect(invokedChannels).not.toContain('shell:pathExists')
    expect(invokedChannels).not.toContain('shell:openFileUri')
    expect(invokedChannels).not.toContain('shell:pickImage')
  })

  it('rejects filesystem and runtime access outside the owned document', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ ok: true })
    const api = createEditorPopoutPreloadApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn()
    } as never)
    await api.editorPopout.getState()

    expect(() => api.fs.readFile({ filePath: '/workspace/note.md' })).toThrowError(
      'Runtime-owned detached editors cannot use host filesystem IPC.'
    )
    expect(() => api.fs.readFile({ filePath: '/workspace/other.md' })).toThrowError(
      'Runtime-owned detached editors cannot use host filesystem IPC.'
    )
    expect(() =>
      api.runtimeEnvironments.call({
        selector: 'runtime-1',
        method: 'terminal.create',
        expectedEnvironmentPairingRevision: 11
      })
    ).toThrowError('Detached editor runtime method is not permitted.')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('allows the owned runtime file operation with the frozen pairing revision', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ ok: true })
    const api = createEditorPopoutPreloadApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn()
    } as never)
    await api.editorPopout.getState()

    await api.runtimeEnvironments.call({
      selector: 'runtime-1',
      method: 'files.write',
      params: {
        worktree: 'id:repo:main',
        relativePath: 'note.md',
        content: '# Updated\n'
      },
      expectedEnvironmentPairingRevision: 11
    })

    expect(invoke).toHaveBeenLastCalledWith(
      'runtimeEnvironments:call',
      expect.objectContaining({ method: 'files.write' })
    )
  })
})
