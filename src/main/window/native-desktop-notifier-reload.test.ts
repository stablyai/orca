import { describe, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { createRuntime } from '../runtime/orca-runtime-test-fixtures.spec'
import {
  beginNativeDesktopNotifierReloadFence,
  markNativeDesktopNotifierReady,
  registerNativeDesktopNotifier,
  restoreNativeDesktopNotifierReady
} from './native-desktop-notifiers'

vi.mock('./desktop-renderer-registry', () => ({ preferredDesktopRenderer: () => null }))

function fixture(recover?: () => boolean) {
  let available = true
  const runtime = createRuntime()
  const capture = vi.spyOn(runtime, 'setNotifier')
  const notifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    setPaneTitle: vi.fn(() => true)
  }
  const window = { id: 81, webContents: { id: 810 }, isDestroyed: () => false }
  const remove = registerNativeDesktopNotifier(runtime, window, notifier, () => available, recover)
  const router = capture.mock.calls.at(-1)?.[0]
  if (!router) {
    throw new Error('Missing native notifier router')
  }
  return {
    runtime,
    notifier,
    window,
    router,
    remove,
    setAvailable: (value: boolean) => {
      available = value
    }
  }
}

describe('native notifier reload delivery contracts', () => {
  it('requests snapshot recovery after overflow without delivering a partial replay', () => {
    const recover = vi.fn(() => true)
    const f = fixture(recover)
    for (let i = 0; i < 200; i += 1) {
      f.router.worktreesChanged(`repo-${i}`)
    }
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(recover).toHaveBeenCalledOnce()
    expect(f.notifier.worktreesChanged).not.toHaveBeenCalled()
    f.router.reposChanged()
    expect(f.notifier.reposChanged).not.toHaveBeenCalled()
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(f.notifier.reposChanged).toHaveBeenCalledOnce()
    f.remove()
  })

  it('retains overflow recovery until the sender accepts it', () => {
    const recover = vi.fn(() => false)
    const f = fixture(recover)
    for (let i = 0; i < 200; i += 1) {
      f.router.worktreesChanged(`repo-${i}`)
    }
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(f.notifier.worktreesChanged).not.toHaveBeenCalled()
    recover.mockReturnValue(true)
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(recover).toHaveBeenCalledTimes(2)
    f.remove()
  })

  it('retains changes for both repos while every renderer is unavailable', () => {
    const f = fixture()
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    beginNativeDesktopNotifierReloadFence(f.runtime, f.window.id)
    f.setAvailable(false)
    f.router.worktreesChanged('repo-a')
    f.router.worktreesChanged('repo-b')
    expect(f.notifier.worktreesChanged).not.toHaveBeenCalled()
    f.setAvailable(true)
    restoreNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(f.notifier.worktreesChanged.mock.calls).toEqual([['repo-a'], ['repo-b']])
    f.remove()
  })

  it('keeps an early current-document readiness ping until the sender becomes available', () => {
    const f = fixture()
    f.setAvailable(false)
    f.router.reposChanged()
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(f.notifier.reposChanged).not.toHaveBeenCalled()
    f.setAvailable(true)
    markNativeDesktopNotifierReady(f.runtime, f.window.id)
    expect(f.notifier.reposChanged).toHaveBeenCalledTimes(1)
    f.remove()
  })

  it('reports false when a pane-title request cannot reach any ready window', () => {
    const f = fixture()
    expect(f.router.setPaneTitle?.('tab', 'leaf', 'title')).toBe(false)
    expect(f.notifier.setPaneTitle).not.toHaveBeenCalled()
    f.remove()
  })
})
