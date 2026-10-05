// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLeftTitlebarChromeLayout } from '@/lib/titlebar-left-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'
import type { FloatingWorkspacePanelState } from './use-floating-workspace-panel'

const state = vi.hoisted(() => ({
  keybindings: { 'sidebar.left.toggle': ['Mod+Q'] },
  settings: { terminalShortcutPolicy: 'orca-first' as const },
  toggleSidebar: vi.fn(),
  toggleRightSidebar: vi.fn(),
  setRightSidebarOpen: vi.fn(),
  setRightSidebarTab: vi.fn(),
  showRightSidebarFiles: vi.fn(),
  showRightSidebarSearch: vi.fn(),
  openDiffNotesSendMenuForActiveWorktree: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => [] }))
vi.mock('./app-window-chrome', () => ({ shortcutPlatform: 'darwin' }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false,
  isFloatingWorkspaceTerminalInputTarget: () => false,
  matchFloatingWorkspacePanelChord: () => null,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut: () => false
}))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))
const { useGlobalKeybindings } = await import('./use-global-keybindings')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const layout: AppChromeLayout = {
  activeView: 'terminal',
  activeWorktreeId: 'workspace',
  activePendingCreationId: null,
  activeTabCanExpand: false,
  effectiveActiveTabId: null,
  collapsedSidebarHeaderWidth: 0,
  creationLayoutActive: false,
  isFullScreen: false,
  leftSidebarStyle: undefined,
  leftTitlebarChromeLayout: resolveLeftTitlebarChromeLayout({
    workspaceChromeActive: true,
    stackedSidebarOpen: false,
    creationLayoutActive: false,
    sidebarOpen: true
  }),
  rightSidebarExplorerView: 'search',
  rightSidebarOpen: true,
  rightSidebarTab: 'explorer',
  shouldMountTerminalWorkbench: true,
  showSidebar: true,
  showRightSidebarControls: true,
  showTitlebarAppName: true,
  showTitlebarExpandButton: false,
  sidebarOpen: true,
  stackedSidebarOpen: false,
  terminalWorkbenchVisible: true,
  titlebarLeftControlsRef: { current: null },
  workspaceChromeActive: true
}
const floatingWorkspace: FloatingWorkspacePanelState = {
  cancelReturnFocusFrame: () => {},
  enabled: false,
  open: false,
  openMaximized: () => {},
  setOpenWithFocus: () => {},
  shouldMountPanel: false,
  showToggleButton: false,
  tourInteractionSnapshotRef: { current: null },
  visibleTabCount: 0
}
let root: Root
let container: HTMLDivElement
function Probe(): null {
  useGlobalKeybindings({ layout, floatingWorkspace })
  return null
}
function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'q',
    code: 'KeyQ',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => target.dispatchEvent(event))
  return event
}
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('global search field IME ownership', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'leaves a composing remapped chord uncancelled: %j',
    (init) => {
      const input = document.createElement('input')
      input.dataset.keyboardSurface = 'search-field'
      document.body.append(input)
      expect(press(input, init).defaultPrevented).toBe(false)
      expect(state.toggleSidebar).not.toHaveBeenCalled()
      expect(press(input, {}).defaultPrevented).toBe(true)
      expect(state.toggleSidebar).toHaveBeenCalledOnce()
    }
  )
  it.each(['button', 'terminal'])(
    'preserves existing %s context behavior for composing events',
    (surface) => {
      const target =
        surface === 'terminal'
          ? document.createElement('textarea')
          : document.createElement('button')
      if (surface === 'terminal') {
        target.className = 'xterm-helper-textarea'
      }
      document.body.append(target)
      expect(press(target, { isComposing: true }).defaultPrevented).toBe(true)
      expect(state.toggleSidebar).toHaveBeenCalledOnce()
    }
  )
})
