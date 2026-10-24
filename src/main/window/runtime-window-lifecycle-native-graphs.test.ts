import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { createRuntime, TEST_WORKTREE_ID } from '../runtime/orca-runtime-test-fixtures.spec'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

vi.mock('./desktop-renderer-registry', () => ({ desktopWindowId: () => 'native' }))
vi.mock('./native-desktop-notifiers', () => ({ registerNativeDesktopNotifier: () => () => {} }))

function windowFixture(id: number) {
  const renderer = Object.assign(new EventEmitter(), {
    id: id * 10,
    send: vi.fn(),
    isDestroyed: () => false,
    getURL: () => 'file:///orca/index.html',
    isLoadingMainFrame: () => false
  })
  const window = Object.assign(new EventEmitter(), {
    id,
    webContents: renderer,
    isDestroyed: () => false
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the window and renderer lifecycle methods exercised by registration.
  return { window: window as unknown as BrowserWindow, renderer }
}

describe('native renderer graph lifecycle', () => {
  it('withdraws a crashed contribution while keeping healthy peers, and requires a new graph after recovery', () => {
    const runtime = createRuntime()
    const first = windowFixture(11)
    const second = windowFixture(22)
    registerRuntimeWindowLifecycle(first.window, runtime)
    registerRuntimeWindowLifecycle(second.window, runtime)
    const graphs = nativeDesktopWindowGraphs(runtime)
    const graph = (tabId: string) => ({
      rendererGeneration: tabId,
      tabs: [
        { tabId, worktreeId: TEST_WORKTREE_ID, title: tabId, activeLeafId: null, layout: null }
      ],
      leaves: []
    })
    graphs.sync(11, graph('first'))
    graphs.sync(22, graph('second'))
    first.renderer.emit('render-process-gone')
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    expect(graphs.windowIdsForTab('first')).toEqual([])
    second.renderer.emit('render-process-gone')
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    second.renderer.emit('did-finish-load')
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    graphs.sync(22, graph('recovered'))
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    first.window.emit('closed')
    second.window.emit('closed')
  })

  it('removes a reloading window and restores its contribution if its original document survives', async () => {
    const runtime = createRuntime()
    const { window, renderer } = windowFixture(33)
    registerRuntimeWindowLifecycle(window, runtime)
    const graphs = nativeDesktopWindowGraphs(runtime)
    graphs.sync(33, { rendererGeneration: 'original', tabs: [], leaves: [] })
    renderer.emit('did-start-navigation', {}, 'file:///orca/index.html', false, true)
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    renderer.emit('did-fail-provisional-load', {}, -3, 'aborted', 'file:///orca/index.html', true)
    await Promise.resolve()
    expect(runtime.getStatus().graphStatus).toBe('ready')
    window.emit('closed')
  })
})
