// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerBrowserAnnotationSendShortcut } from '@/lib/browser-annotation-send-shortcut'
import { useGlobalKeybindings } from './use-global-keybindings'
import { useAppChromeLayout } from './use-app-chrome-layout'
import { useFloatingWorkspacePanel } from './use-floating-workspace-panel'
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => [] }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'win32' }))
vi.mock('@/app-shell/app-window-chrome', () => ({ shortcutPlatform: 'win32' }))
vi.mock('../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

const initial = useAppStore.getState()
let unregister: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'main',
    keybindings: { 'sourceControl.sendReviewNotes': ['DoubleTap+Shift'] }
  })
})
afterEach(() => {
  unregister?.()
  cleanup()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

// The guest bridge replays a double tap as a keydown without a key, carrying the page and modifier.
function replayGuestDoubleTap(doubleTapModifier: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true })
  Object.assign(event, { browserPageId: 'page-1', doubleTapModifier })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  document.body.dispatchEvent(event)
  return event
}

it('opens the browser annotation menu for a replayed guest double tap', () => {
  const openMenu = vi.fn(() => 'opened' as const)
  unregister = registerBrowserAnnotationSendShortcut(openMenu)
  renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )

  const event = replayGuestDoubleTap('Shift')

  expect(openMenu).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-1' }))
  expect(event.defaultPrevented).toBe(true)
})

it('ignores a replayed double tap of another modifier', () => {
  const openMenu = vi.fn(() => 'opened' as const)
  unregister = registerBrowserAnnotationSendShortcut(openMenu)
  renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )

  const event = replayGuestDoubleTap('Alt')

  expect(openMenu).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})
