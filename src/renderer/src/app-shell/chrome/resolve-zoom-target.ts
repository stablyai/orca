import type { TopLevelView } from '../../../../shared/ui-chrome/ui-chrome-types'
import type { WorkspaceVisibleTabType } from '../../../../shared/workspace-layout/tab-groups/tab-types'

function closestFocusedElement(element: unknown, selector: string): unknown {
  if (
    typeof element === 'object' &&
    element !== null &&
    'closest' in element &&
    typeof element.closest === 'function'
  ) {
    return element.closest(selector)
  }
  return null
}

const BROWSER_PAGE_ID_ATTRIBUTES = [
  'data-browser-page-pane-id',
  'data-browser-page-viewport-id',
  'data-browser-page-menu-id'
]

/** Resolve browser page focus from page, address bar/toolbar or external menu, which may live outside the pane. */
export function focusedBrowserPageId(activeElement: unknown): string | null {
  for (const attribute of BROWSER_PAGE_ID_ATTRIBUTES) {
    const owner = closestFocusedElement(activeElement, `[${attribute}]`)
    if (
      typeof owner === 'object' &&
      owner !== null &&
      'getAttribute' in owner &&
      typeof owner.getAttribute === 'function'
    ) {
      const browserPageId: unknown = owner.getAttribute(attribute)
      return typeof browserPageId === 'string' ? browserPageId : null
    }
  }
  return null
}

/** Zoom belongs to the focused surface within the current workspace. */
export function resolveZoomTarget(args: {
  activeView: TopLevelView
  activeTabType: WorkspaceVisibleTabType
  activeElement: unknown
}): 'terminal' | 'editor' | 'chat' | 'browser' | 'sidebar' | 'panel' {
  const { activeView, activeTabType, activeElement } = args
  if (closestFocusedElement(activeElement, '[data-sidebar-zoom]')) {
    return 'sidebar'
  }
  const terminalInputFocused =
    typeof activeElement === 'object' &&
    activeElement !== null &&
    'classList' in activeElement &&
    typeof (activeElement as { classList?: { contains?: unknown } }).classList?.contains ===
      'function' &&
    (activeElement as { classList: { contains: (token: string) => boolean } }).classList.contains(
      'xterm-helper-textarea'
    )
  const chatFocused = Boolean(closestFocusedElement(activeElement, '[data-native-chat-root]'))
  const editorFocused = Boolean(
    closestFocusedElement(
      activeElement,
      '[data-editor-panel], .monaco-editor, .diff-editor, .markdown-preview, .rich-markdown-editor, .rich-markdown-editor-shell'
    )
  )

  // Address-bar/toolbar focus zooms its page; floating browsers can own focus over Tasks/Settings.
  if (focusedBrowserPageId(activeElement)) {
    return 'browser'
  }
  if (activeView !== 'terminal') {
    return 'panel'
  }
  if (chatFocused) {
    return 'chat'
  }
  if (editorFocused || (activeTabType === 'editor' && activeElement === document.body)) {
    return 'editor'
  }
  // After focus moves to app chrome, app zoom owns the chord even if a terminal remains visible.
  if (terminalInputFocused) {
    return 'terminal'
  }
  return 'panel'
}
