import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebHybridShellPresentation } from './MobileWebHybridShellPresentation'
import { mobileWebShellLoadFailureWarning } from './mobile-web-shell-load-failure-warning'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  MonitorSmartphone: 'MonitorSmartphone'
}))

vi.mock('@orca/expo-mobile-web-shell', () => ({
  MobileWebShellView: 'MobileWebShellView'
}))

const noop = () => {}

describe('hosted shell document load failures', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('hands the native failure reason to the shell instead of leaving the error page unexplained', () => {
    const failures: (string | undefined)[] = []
    const loaded = vi.fn()

    act(() => {
      renderer = create(
        createElement(MobileWebHybridShellPresentation, {
          viewRef: { current: null },
          selectedHost: { id: 'host-1', name: 'Desk', publicKeyB64: 'k' } as never,
          session: { sessionId: 'abc', buildId: 'build-1' } as never,
          viewEpoch: 0,
          packageLoading: false,
          packageProgress: undefined,
          packageWarning: undefined,
          hostedViewActive: true,
          onBack: noop,
          onShowHosts: noop,
          onRetryRecovery: noop,
          onUsePrevious: noop,
          onClearCache: noop,
          onRecoveryFailure: noop,
          onBridgeMessage: noop,
          onDocumentLoadStarted: noop,
          onPageLoaded: loaded,
          onLoadFailed: (reason) => failures.push(reason),
          onNavigationBlocked: noop,
          onProcessTerminated: noop
        })
      )
    })

    const shell = renderer!.root.findByType('MobileWebShellView' as never)
    act(() => {
      shell.props.onLoadState({
        nativeEvent: { state: 'failed', reason: 'mobile_web_document_http_403' }
      })
    })

    expect(failures).toEqual(['mobile_web_document_http_403'])
    expect(loaded).not.toHaveBeenCalled()
  })

  it('names the failure in copy the hosted shell can show', () => {
    expect(mobileWebShellLoadFailureWarning('mobile_web_document_http_403')).toEqual({
      message: 'Couldn’t open Orca.',
      code: 'mobile_web_document_http_403'
    })
    expect(mobileWebShellLoadFailureWarning('mobile_web_generation_invalid')).toEqual({
      message: 'Couldn’t open the last version that worked.',
      code: 'mobile_web_generation_invalid'
    })
    expect(mobileWebShellLoadFailureWarning(undefined)).toEqual({
      message: 'Couldn’t open Orca.',
      code: undefined
    })
  })
})
