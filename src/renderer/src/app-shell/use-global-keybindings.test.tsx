// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppChromeLayout } from './use-app-chrome-layout'
import type { FloatingWorkspacePanelState } from './use-floating-workspace-panel'

const storeFixture = vi.hoisted(() => ({
  keybindings: { 'sourceControl.sendReviewNotes': ['Mod+Shift+Enter'] },
  openDiffNotesSendMenuForActiveWorktree: vi.fn(() => true),
  setRightSidebarOpen: vi.fn(),
  setRightSidebarTab: vi.fn(),
  settings: { terminalShortcutPolicy: 'orca-first' },
  showRightSidebarFiles: vi.fn(),
  showRightSidebarSearch: vi.fn(),
  toggleRightSidebar: vi.fn(),
  toggleSidebar: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => [] }))
vi.mock('./app-window-chrome', () => ({ shortcutPlatform: 'darwin' }))

import { useGlobalKeybindings } from './use-global-keybindings'

function renderGlobalKeybindings() {
  const layout = {
    activeView: 'terminal',
    activeWorktreeId: 'worktree-1',
    creationLayoutActive: false,
    workspaceChromeActive: true
  } as AppChromeLayout
  const floatingWorkspace = {
    enabled: false,
    open: false,
    visibleTabCount: 0,
    openMaximized: vi.fn(),
    setOpenWithFocus: vi.fn()
  } as unknown as FloatingWorkspacePanelState
  return renderHook(() => useGlobalKeybindings({ layout, floatingWorkspace }))
}

function dispatchSendReviewNotesShortcut(onDownstreamKeyDown?: () => void): KeyboardEvent {
  const textarea = document.createElement('textarea')
  if (onDownstreamKeyDown) {
    textarea.addEventListener('keydown', onDownstreamKeyDown)
  }
  document.body.appendChild(textarea)
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true
  })
  textarea.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useGlobalKeybindings', () => {
  it('sends saved review notes while an editable diff surface owns focus', () => {
    const hook = renderGlobalKeybindings()
    const onDownstreamKeyDown = vi.fn()
    const event = dispatchSendReviewNotesShortcut(onDownstreamKeyDown)

    expect(event.defaultPrevented).toBe(true)
    expect(storeFixture.openDiffNotesSendMenuForActiveWorktree).toHaveBeenCalledOnce()
    expect(onDownstreamKeyDown).not.toHaveBeenCalled()

    hook.unmount()
  })

  it('leaves the editable shortcut unclaimed when there are no unsent notes', () => {
    storeFixture.openDiffNotesSendMenuForActiveWorktree.mockReturnValueOnce(false)
    const hook = renderGlobalKeybindings()
    const event = dispatchSendReviewNotesShortcut()

    expect(event.defaultPrevented).toBe(false)
    expect(storeFixture.openDiffNotesSendMenuForActiveWorktree).toHaveBeenCalledOnce()

    hook.unmount()
  })
})
