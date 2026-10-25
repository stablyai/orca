import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { createRuntime } from '../runtime/orca-runtime-test-fixtures.spec'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'
import { markNativeDesktopNotifierReady } from './native-desktop-notifiers'

vi.mock('./desktop-renderer-registry', () => ({
  desktopWindowId: () => 'native',
  preferredDesktopRenderer: () => null
}))

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies only the window/webContents members this lifecycle wiring reads.
  return { window: window as unknown as BrowserWindow, renderer }
}

function router(runtime: ReturnType<typeof createRuntime>) {
  const target = vi.mocked(runtime.setNotifier).mock.calls.at(-1)?.[0]
  if (!target) {
    throw new Error('No native notifier router')
  }
  return target
}

describe('runtime window lifecycle notifier readiness wiring', () => {
  it('replays a current-document ping that arrived before did-finish-load', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'setNotifier')
    const { window, renderer } = windowFixture(41)
    registerRuntimeWindowLifecycle(window, runtime)

    renderer.emit('did-start-navigation', {}, 'file:///orca/index.html', false, true)
    renderer.emit('did-frame-navigate', {}, 'file:///orca/index.html', 200, 'OK', true)
    router(runtime).reposChanged()
    markNativeDesktopNotifierReady(runtime, window.id)
    expect(renderer.send).not.toHaveBeenCalledWith('repos:changed')
    renderer.emit('did-finish-load')

    expect(renderer.send).toHaveBeenCalledWith('repos:changed')
    renderer.send.mockClear()
    router(runtime).reposChanged()
    expect(renderer.send).toHaveBeenCalledWith('repos:changed')
    window.emit('closed')
  })

  it('requires a fresh ping after a main-frame commit even though the prior document was ready', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'setNotifier')
    const { window, renderer } = windowFixture(42)
    registerRuntimeWindowLifecycle(window, runtime)
    markNativeDesktopNotifierReady(runtime, window.id)

    renderer.emit('did-start-navigation', {}, 'file:///orca/index.html', false, true)
    renderer.emit('did-frame-navigate', {}, 'file:///orca/index.html', 200, 'OK', true)
    renderer.emit('did-finish-load')
    router(runtime).reposChanged()
    expect(renderer.send).not.toHaveBeenCalledWith('repos:changed')

    markNativeDesktopNotifierReady(runtime, window.id)
    expect(renderer.send).toHaveBeenCalledWith('repos:changed')
    window.emit('closed')
  })

  it('restores prior readiness after a cancelled reload without requiring a new ping', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'setNotifier')
    const { window, renderer } = windowFixture(43)
    registerRuntimeWindowLifecycle(window, runtime)
    markNativeDesktopNotifierReady(runtime, window.id)

    renderer.emit('did-start-navigation', {}, 'file:///orca/index.html', false, true)
    router(runtime).reposChanged()
    expect(renderer.send).not.toHaveBeenCalledWith('repos:changed')

    renderer.emit('did-fail-provisional-load', {}, -3, 'aborted', 'file:///orca/index.html', true)
    return Promise.resolve().then(() => {
      expect(renderer.send).toHaveBeenCalledWith('repos:changed')
      window.emit('closed')
    })
  })

  it('drops readiness on a renderer crash, requiring both recovery and a new ping before replay', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'setNotifier')
    const { window, renderer } = windowFixture(44)
    registerRuntimeWindowLifecycle(window, runtime)
    markNativeDesktopNotifierReady(runtime, window.id)

    renderer.emit('render-process-gone')
    router(runtime).reposChanged()
    // A ping received while the renderer process is still gone proves nothing: no respawned
    // document can have sent it, and there is still no live renderer to deliver to.
    markNativeDesktopNotifierReady(runtime, window.id)
    expect(renderer.send).not.toHaveBeenCalledWith('repos:changed')

    // The respawned renderer finishes loading and pings readiness; now delivery is live again.
    renderer.emit('did-frame-navigate', {}, 'file:///orca/index.html', 200, 'OK', true)
    renderer.emit('did-finish-load')
    markNativeDesktopNotifierReady(runtime, window.id)
    expect(renderer.send).toHaveBeenCalledWith('repos:changed')
    window.emit('closed')
  })
})
