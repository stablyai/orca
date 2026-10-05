import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import type { MobileSessionController } from './use-mobile-session-controller'

vi.mock('react-native', () => ({
  Animated: { View: 'AnimatedView' },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator'
}))
vi.mock('../storage/preferences', () => ({ saveTerminalTextScale: vi.fn() }))
vi.mock('../browser/MobileBrowserPane', () => ({ MobileBrowserPane: 'BrowserPane' }))
vi.mock('./TerminalPaneView', () => ({ TerminalPaneView: 'TerminalPane' }))
vi.mock('./MobileNativeChatOverlay', () => ({ MobileNativeChatOverlay: 'ChatOverlay' }))
vi.mock('./MobileSessionFileReader', () => ({ FileReader: 'FileReader' }))
vi.mock('./MobileSessionMarkdownReader', () => ({ MarkdownReader: 'MarkdownReader' }))
vi.mock('../theme/mobile-theme', () => ({ colors: {} }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))

const pendingChatRow = {
  type: 'terminal',
  id: 'P::L',
  title: '',
  leafId: 'L',
  status: 'pending-handle',
  terminal: null,
  viewMode: 'chat',
  isActive: true
}

type Flags = {
  activeChatSurface?: boolean
  showEmptyState?: boolean
  activeViewUndecided?: boolean
  toastMessage?: string | null
}

function contentElement(flags: Flags) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the active content reads only these members for a terminal tab; the rest of the controller is unreachable here.
  const controller = {
    terminals: [],
    showLoadingState: false,
    showEmptyState: flags.showEmptyState ?? false,
    activeMarkdownTab: null,
    activeFileTab: null,
    activeBrowserTab: null,
    activePendingTerminalTab: pendingChatRow,
    activeChatSurface: flags.activeChatSurface ?? false,
    activeViewUndecided: flags.activeViewUndecided ?? false,
    isPendingTerminalRecoveryParked: false,
    toastMessage: flags.toastMessage ?? null,
    nativeChatSendError: { message: null, clear: vi.fn() },
    dictation: { isRecording: false },
    notifyTerminalFrame: vi.fn()
  } as unknown as MobileSessionController
  return createElement(MobileSessionActiveContent, { controller })
}

describe('MobileSessionActiveContent with a chat row that has no terminal handle (A1c-6)', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(flags: Flags): void {
    act(() => {
      renderer = create(contentElement(flags))
    })
  }

  function texts(): string[] {
    return renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
  }

  function has(type: string): boolean {
    return renderer!.root.findAll((node) => String(node.type) === type).length > 0
  }

  it('renders the chosen chat instead of "Loading terminal" while recovery runs', () => {
    render({ activeChatSurface: true })
    expect(has('ChatOverlay')).toBe(true)
    expect(texts()).not.toContain('Loading terminal')
  })

  it('shows a failed switch toast on the chat surface', () => {
    render({ activeChatSurface: true, toastMessage: "Couldn't confirm the view switch" })
    expect(texts()).toContain("Couldn't confirm the view switch")
  })

  it('returns to the terminal recovery view, with its toast, once the pair says terminal', () => {
    render({ activeChatSurface: false, toastMessage: "Couldn't confirm the view switch" })
    expect(has('ChatOverlay')).toBe(false)
    expect(texts()).toContain('Loading terminal')
    expect(texts()).toContain("Couldn't confirm the view switch")
  })

  it('waits on a settling default with the neutral spinner only', () => {
    render({ activeViewUndecided: true })
    expect(has('ActivityIndicator')).toBe(true)
    expect(has('ChatOverlay')).toBe(false)
    expect(texts()).toEqual([])
  })

  it('shows a failed switch toast once under the spinner and the empty state too (R3-F3)', () => {
    const toast = "Couldn't confirm the view switch"
    render({ activeViewUndecided: true, toastMessage: toast })
    expect(texts()).toEqual([toast])
    act(() => renderer?.unmount())
    render({ showEmptyState: true, toastMessage: toast })
    expect(texts().filter((text) => text === toast)).toHaveLength(1)
    act(() => renderer?.unmount())
    render({ activeChatSurface: true, toastMessage: toast })
    expect(texts().filter((text) => text === toast)).toHaveLength(1)
  })
})
