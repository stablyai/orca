import { afterEach, describe, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { createRuntime, TEST_WORKTREE_ID } from '../runtime/orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import type { WebContents } from 'electron'

const preferred = vi.hoisted(() => vi.fn<() => Pick<WebContents, 'id'> | null>(() => null))
vi.mock('./desktop-renderer-registry', () => ({ preferredDesktopRenderer: preferred }))
import { registerNativeDesktopNotifier } from './native-desktop-notifiers'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import { leaf } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'

function windowFixture(id: number) {
  return { id, webContents: { id }, isDestroyed: () => false }
}

function notifier(): RuntimeNotifier {
  return {
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
})
