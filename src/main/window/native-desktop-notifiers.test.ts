import { afterEach, describe, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { createRuntime, TEST_WORKTREE_ID } from '../runtime/orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import type { WebContents } from 'electron'

const preferred = vi.hoisted(() => vi.fn<() => Pick<WebContents, 'id'> | null>(() => null))
vi.mock('./desktop-renderer-registry', () => ({ preferredDesktopRenderer: preferred }))
import {
  registerNativeDesktopNotifier,
  markNativeDesktopNotifierReady,
  beginNativeDesktopNotifierReloadFence,
  restoreNativeDesktopNotifierReady,
  markNativeDesktopNotifierUnready
} from './native-desktop-notifiers'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import { leaf } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'

function windowFixture(id: number) {
  return { id, webContents: { id }, isDestroyed: () => false }
}

function notifier(): RuntimeNotifier {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    browserProfilesChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    setPaneTitle: vi.fn(() => true),
    revealTerminalSession: vi.fn(async () => ({ tabId: 'tab-x' }))
  }
}

afterEach(() => preferred.mockReturnValue(null))

describe('native desktop notifications', () => {
  it('broadcasts state while sending tab commands to a window that owns the tab', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(101)
    const second = windowFixture(202)
    const a = notifier()
    const b = notifier()
    const removeA = registerNativeDesktopNotifier(runtime, first, a, () => true)
    const removeB = registerNativeDesktopNotifier(runtime, second, b, () => true)
    markNativeDesktopNotifierReady(runtime, first.id)
    markNativeDesktopNotifierReady(runtime, second.id)
    nativeDesktopWindowGraphs(runtime).sync(second.id, {
      rendererGeneration: 'second',
      tabs: [
        {
          tabId: 'second-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Second',
          activeLeafId: leaf(1),
          layout: null
        }
      ],
      leaves: []
    })
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    preferred.mockReturnValue(first.webContents)
    router.reposChanged()
    expect(a.reposChanged).toHaveBeenCalledTimes(1)
    expect(b.reposChanged).toHaveBeenCalledTimes(1)
    router.renameTerminal('second-tab', 'Renamed')
    expect(a.renameTerminal).not.toHaveBeenCalled()
    expect(b.renameTerminal).toHaveBeenCalledWith('second-tab', 'Renamed')
    expect(router.setPaneTitle?.('second-tab', leaf(1), 'Pane')).toBe(true)
    removeA()
    const surviving = capture.mock.calls.at(-1)?.[0]
    surviving?.createTerminal(TEST_WORKTREE_ID, {})
    expect(b.createTerminal).toHaveBeenCalledWith(TEST_WORKTREE_ID, {})
    removeB()
    expect(capture.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('broadcasts browserProfilesChanged to every live window', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(301)
    const second = windowFixture(302)
    const a = notifier()
    const b = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    registerNativeDesktopNotifier(runtime, second, b, () => true)
    markNativeDesktopNotifierReady(runtime, first.id)
    markNativeDesktopNotifierReady(runtime, second.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.browserProfilesChanged?.()
    expect(a.browserProfilesChanged).toHaveBeenCalledTimes(1)
    expect(b.browserProfilesChanged).toHaveBeenCalledTimes(1)
  })

  it('buffers a broadcast for a not-yet-ready window and replays it once ready, without duplicating delivery to an already-ready peer', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(401)
    const second = windowFixture(402)
    const a = notifier()
    const b = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    registerNativeDesktopNotifier(runtime, second, b, () => true)
    // Only the first window proved its listeners are mounted.
    markNativeDesktopNotifierReady(runtime, first.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.browserProfilesChanged?.()
    expect(a.browserProfilesChanged).toHaveBeenCalledTimes(1)
    expect(b.browserProfilesChanged).not.toHaveBeenCalled()
    markNativeDesktopNotifierReady(runtime, second.id)
    expect(b.browserProfilesChanged).toHaveBeenCalledTimes(1)
    // The already-ready window must not be sent the event a second time.
    expect(a.browserProfilesChanged).toHaveBeenCalledTimes(1)
  })

  it('replays every repeated broadcast for an unready window, not just the latest', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(403)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.reposChanged()
    router.reposChanged()
    router.reposChanged()
    expect(a.reposChanged).not.toHaveBeenCalled()
    markNativeDesktopNotifierReady(runtime, first.id)
    expect(a.reposChanged).toHaveBeenCalledTimes(3)
  })

  it('retains a distinct notice per repo while unavailable, not just the most recent repo', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(405)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    markNativeDesktopNotifierReady(runtime, first.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    beginNativeDesktopNotifierReloadFence(runtime, first.id)
    router.worktreesChanged('repo-a')
    router.worktreesChanged('repo-b')
    expect(a.worktreesChanged).not.toHaveBeenCalled()
    restoreNativeDesktopNotifierReady(runtime, first.id)
    expect(a.worktreesChanged).toHaveBeenCalledTimes(2)
    expect(a.worktreesChanged).toHaveBeenNthCalledWith(1, 'repo-a')
    expect(a.worktreesChanged).toHaveBeenNthCalledWith(2, 'repo-b')
  })

  it('rejects an async request with no eligible target instead of throwing synchronously', async () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(501)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    // The window is live but never pinged readiness, so it is not an eligible target yet.
    let caught: unknown
    let result: unknown
    try {
      result = router.revealTerminalSession?.(TEST_WORKTREE_ID, { ptyId: 'pty-1' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeUndefined()
    await expect(Promise.resolve(result)).rejects.toThrow('runtime_unavailable')
    expect(a.revealTerminalSession).not.toHaveBeenCalled()
  })

  it('no-ops a void routed command with no eligible target', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(502)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    expect(() => router.renameTerminal('tab-1', 'Title')).not.toThrow()
    expect(a.renameTerminal).not.toHaveBeenCalled()
  })

  it('releases buffered state and readiness when the window closes', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(601)
    const a = notifier()
    const remove = registerNativeDesktopNotifier(runtime, first, a, () => true)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.reposChanged()
    remove()
    // Re-registering a fresh window reusing the same id must not inherit the closed window's buffer.
    const reopened = windowFixture(601)
    const b = notifier()
    registerNativeDesktopNotifier(runtime, reopened, b, () => true)
    markNativeDesktopNotifierReady(runtime, reopened.id)
    expect(b.reposChanged).not.toHaveBeenCalled()
  })

  it('keeps a window ready across a cancelled reload and replays what it missed while the fence was up', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(701)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    markNativeDesktopNotifierReady(runtime, first.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    beginNativeDesktopNotifierReloadFence(runtime, first.id)
    router.reposChanged()
    expect(a.reposChanged).not.toHaveBeenCalled()
    restoreNativeDesktopNotifierReady(runtime, first.id)
    expect(a.reposChanged).toHaveBeenCalledTimes(1)
    router.reposChanged()
    expect(a.reposChanged).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect readiness from a stale cancellation after a real reload completed', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(702)
    const a = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    markNativeDesktopNotifierReady(runtime, first.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    beginNativeDesktopNotifierReloadFence(runtime, first.id)
    // The reload actually commits before the (now-superseded) cancellation handler runs.
    markNativeDesktopNotifierUnready(runtime, first.id)
    restoreNativeDesktopNotifierReady(runtime, first.id)
    router.reposChanged()
    expect(a.reposChanged).not.toHaveBeenCalled()
  })

  it('buffers a broadcast sent while a window is mid-reload (available false, not destroyed) instead of dropping it', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(404)
    const a = notifier()
    let available = true
    registerNativeDesktopNotifier(runtime, first, a, () => available)
    markNativeDesktopNotifierReady(runtime, first.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    beginNativeDesktopNotifierReloadFence(runtime, first.id)
    available = false
    router.reposChanged()
    expect(a.reposChanged).not.toHaveBeenCalled()
    available = true
    restoreNativeDesktopNotifierReady(runtime, first.id)
    expect(a.reposChanged).toHaveBeenCalledTimes(1)
  })

  it('does not replay into a window destroyed between the ready ping and the flush', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(801)
    const a = notifier()
    let destroyed = false
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    first.isDestroyed = () => destroyed
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.reposChanged()
    destroyed = true
    markNativeDesktopNotifierReady(runtime, first.id)
    expect(a.reposChanged).not.toHaveBeenCalled()
  })

  it('never requires readiness to route a broadcast away from an unready live window toward a ready one', () => {
    const runtime = createRuntime()
    const capture = vi.spyOn(runtime, 'setNotifier')
    const first = windowFixture(703)
    const second = windowFixture(704)
    const a = notifier()
    const b = notifier()
    registerNativeDesktopNotifier(runtime, first, a, () => true)
    registerNativeDesktopNotifier(runtime, second, b, () => true)
    markNativeDesktopNotifierReady(runtime, second.id)
    const router = capture.mock.calls.at(-1)?.[0]
    if (!router) {
      throw new Error('No native notifier router')
    }
    router.reposChanged()
    expect(b.reposChanged).toHaveBeenCalledTimes(1)
    expect(a.reposChanged).not.toHaveBeenCalled()
    markNativeDesktopNotifierReady(runtime, first.id)
    expect(a.reposChanged).toHaveBeenCalledTimes(1)
  })
})
