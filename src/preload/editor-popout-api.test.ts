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
    const api = createEditorPopoutPreloadApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn()
    } as never)

    await api.editorPopout.getState()

    expect(Object.keys(api).sort()).toEqual(['editorPopout', 'fs', 'runtimeEnvironments'])
    expect(api).not.toHaveProperty('shell')
    expect(api).not.toHaveProperty('terminal')
    expect(api.fs).not.toHaveProperty('authorizeExternalPath')
  })

  it('rejects filesystem and runtime access outside the owned document', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(request).mockResolvedValue({ ok: true })
    const api = createEditorPopoutPreloadApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn()
    } as never)
    await api.editorPopout.getState()

    expect(() => api.fs.readFile({ filePath: '/workspace/other.md' })).toThrowError(
      'Detached editor filesystem access is outside the owned document.'
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
