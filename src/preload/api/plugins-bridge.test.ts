import { describe, expect, it, vi } from 'vitest'
import type { PluginMarkdownRenderRequest } from '../../shared/plugins/plugin-markdown-renderer'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({ ipcRenderer: mocks }))
import { pluginsApi } from './plugins-bridge'

describe('Markdown renderer preload bridge', () => {
  it('forwards the exact source and render identity without adding active workspace context', async () => {
    const source = {
      fileId: 'file',
      documentPath: '/notes/a.md',
      worktreeId: 'folder:notes',
      runtimeEnvironmentId: null
    }
    await pluginsApi.resolveMarkdownSource(source)
    expect(mocks.invoke).toHaveBeenLastCalledWith('plugins:resolveMarkdownSource', source)
    const render: PluginMarkdownRenderRequest = {
      language: 'dataview',
      code: 'LIST',
      sessionId: 'block',
      source: {
        runtimeId: 'runtime',
        fileId: 'file',
        documentPath: '/notes/a.md',
        worktreeId: 'folder:notes',
        workspacePath: '/notes'
      }
    }
    await pluginsApi.renderMarkdown(render)
    expect(mocks.invoke).toHaveBeenLastCalledWith('plugins:renderMarkdown', render)
    await pluginsApi.cancelMarkdownRender({ sessionId: 'block' })
    expect(mocks.invoke).toHaveBeenLastCalledWith('plugins:cancelMarkdownRender', {
      sessionId: 'block'
    })
    await pluginsApi.listMarkdownRenderers()
    expect(mocks.invoke).toHaveBeenLastCalledWith('plugins:listMarkdownRenderers')
  })

  it('uses the existing unsubscribe-capable provider change stream', () => {
    const listener = vi.fn()
    const unsubscribe = pluginsApi.onChanged(listener)
    expect(mocks.on).toHaveBeenCalledWith('plugins:changed', expect.any(Function))
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('plugins:changed', expect.any(Function))
  })
})
