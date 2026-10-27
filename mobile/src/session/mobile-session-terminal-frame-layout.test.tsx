import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

type LayoutEvent = { nativeEvent: { layout: { width: number; height: number } } }
type ViewProps = { children?: ReactNode; onLayout?: (event: LayoutEvent) => void }

// Model react-native-web’s mount-only ResizeObserver: adding onLayout after mount never observes the View.
const { FRAME, WebView } = await vi.hoisted(async () => {
  const react = await import('react')
  const frame = { width: 390, height: 600 }
  class View extends react.Component<ViewProps> {
    componentDidMount(): void {
      this.props.onLayout?.({ nativeEvent: { layout: frame } })
    }
    render(): ReactNode {
      return react.createElement('div', null, this.props.children)
    }
  }
  return { FRAME: frame, WebView: View }
})

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: WebView,
  Text: WebView,
  Pressable: WebView,
  ActivityIndicator: WebView,
  Animated: { View: WebView },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('../storage/preferences', () => ({ saveTerminalTextScale: () => Promise.resolve() }))
vi.mock('../browser/MobileBrowserPane', () => ({ MobileBrowserPane: () => null }))
vi.mock('./TerminalPaneView', () => ({ TerminalPaneView: () => null }))
vi.mock('./MobileNativeChatOverlay', () => ({ MobileNativeChatOverlay: () => null }))
vi.mock('../transport/use-host-profile', () => ({ useHostProfile: () => null }))
vi.mock('./MobileSessionFileReader', () => ({ FileReader: () => null }))
vi.mock('./MobileSessionMarkdownReader', () => ({ MarkdownReader: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))

import { MobileSessionActiveContent } from './MobileSessionActiveContent'

type Controller = Parameters<typeof MobileSessionActiveContent>[0]['controller']

type Branch = 'loading' | 'pending' | 'terminal'

function controller(
  branch: Branch | boolean,
  notifyTerminalFrame: (frame: { width: number; height: number }) => void
): Controller {
  const shown = branch === true ? 'loading' : branch === false ? 'terminal' : branch
  const scope = {
    showLoadingState: shown === 'loading',
    activePendingTerminalTab: shown === 'pending' ? { title: 'Loading terminal' } : null,
    isPendingTerminalRecoveryParked: false,
    showEmptyState: false,
    terminals: [],
    notifyTerminalFrame,
    dictation: { isRecording: false },
    nativeChatSendError: { message: null, clear: () => {} }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loading and terminal-frame branches read only these members; every other branch is off.
  return scope as unknown as Controller
}

describe('the terminal frame on the page', () => {
  it('stays one mounted frame across loading, a pending terminal and the terminal', () => {
    const heights: number[] = []
    const notify = (frame: { height: number }): void => {
      heights.push(frame.height)
    }
    let renderer: ReturnType<typeof create> | undefined
    const show = (branch: Branch) => {
      const element = createElement(MobileSessionActiveContent, {
        controller: controller(branch, notify)
      })
      act(() => {
        if (renderer) {
          renderer.update(element)
        } else {
          renderer = create(element)
        }
      })
    }
    show('loading')
    show('terminal')
    show('pending')
    show('terminal')
    expect(heights).toEqual([FRAME.height])
  })
})
