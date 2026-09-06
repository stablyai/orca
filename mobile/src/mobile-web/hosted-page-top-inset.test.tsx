import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: CI's type-aware lint resolves react-test-renderer's types as any, which collapses any
// union naming them; a structural handle keeps the ref's null branch meaningful.
type Renderer = { unmount(): void; toJSON(): unknown }

const deviceInsets = vi.hoisted(() => ({ top: 44, bottom: 34, left: 0, right: 0 }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

// Mirrors the library: useSafeAreaInsets is useContext(SafeAreaInsetsContext), and the root value
// is what SafeAreaProvider measures from env(safe-area-inset-*) inside the WebView.
vi.mock('react-native-safe-area-context', async () => {
  const { createContext, useContext } = await import('react')
  const SafeAreaInsetsContext = createContext(deviceInsets)
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) }
})

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  MonitorSmartphone: 'MonitorSmartphone'
}))

vi.mock('@orca/expo-mobile-web-shell', () => ({ MobileWebShellView: 'MobileWebShellView' }))

const { HostedPageTopInsetProvider, hostedPageTopInset } = await import('./hosted-page-top-inset')
const { MobileWebHybridShellPresentation } = await import('./MobileWebHybridShellPresentation')
const { useSafeAreaInsets } = await import('react-native-safe-area-context')

const hostedLayoutSource = readFileSync(
  new URL('../../host-web-app/_layout.tsx', import.meta.url),
  'utf8'
)

const noop = () => {}

type RenderNode = { type: string; props: Record<string, unknown>; children: RenderNode[] | null }

function styleValue(style: unknown, key: string): number {
  if (Array.isArray(style)) {
    return style.reduce((total: number, entry) => total + styleValue(entry, key), 0)
  }
  if (style && typeof style === 'object') {
    const value = (style as Record<string, unknown>)[key]
    return typeof value === 'number' ? value : 0
  }
  return 0
}

// Sums every paddingTop the shell puts between the screen edge and the hosted document.
function shellPaddingAboveWebView(node: RenderNode | string | null, total = 0): number | null {
  if (!node || typeof node !== 'object') {
    return null
  }
  const running = total + styleValue(node.props?.style, 'paddingTop')
  if (node.type === 'MobileWebShellView') {
    return running
  }
  for (const child of node.children ?? []) {
    const found = shellPaddingAboveWebView(child, running)
    if (found !== null) {
      return found
    }
  }
  return null
}

function renderHostedShell(renderer: { current: Renderer | null }): RenderNode {
  act(() => {
    renderer.current = create(
      createElement(MobileWebHybridShellPresentation, {
        viewRef: { current: null },
        selectedHost: { id: 'host-1', name: 'Host 1', publicKeyB64: 'k' } as never,
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
        onPageLoaded: noop,
        onLoadFailed: noop,
        onNavigationBlocked: noop,
        onProcessTerminated: noop
      })
    )
  })
  return renderer.current!.toJSON() as unknown as RenderNode
}

describe('hosted page top inset', () => {
  const renderer: { current: Renderer | null } = { current: null }

  afterEach(() => {
    act(() => renderer.current?.unmount())
    renderer.current = null
  })

  it('drops the top inset the shell already reserved and keeps the edges the WebView still meets', () => {
    expect(hostedPageTopInset(deviceInsets)).toEqual({ top: 0, bottom: 34, left: 0, right: 0 })
  })

  it('hands hosted screens a zero top inset in place of the measured one', () => {
    let seen: unknown = null
    function Probe() {
      seen = useSafeAreaInsets()
      return null
    }
    act(() => {
      renderer.current = create(
        createElement(
          HostedPageTopInsetProvider as (props: { children: ReactNode }) => ReactNode,
          null,
          createElement(Probe)
        ) as never
      )
    })
    expect(seen).toEqual({ top: 0, bottom: 34, left: 0, right: 0 })
  })

  it('reserves the top inset once across the shell and the hosted document', () => {
    const shellPadding = shellPaddingAboveWebView(renderHostedShell(renderer))
    expect(shellPadding).toBe(deviceInsets.top)
    expect(shellPadding! + hostedPageTopInset(deviceInsets).top).toBe(deviceInsets.top)
  })

  it('installs the hosted inset owner inside the hosted route root', () => {
    expect(hostedLayoutSource).toContain(
      "import { HostedPageTopInsetProvider } from '../src/mobile-web/hosted-page-top-inset'"
    )
    expect(hostedLayoutSource).toContain('<HostedPageTopInsetProvider>')
    expect(hostedLayoutSource).toContain('</HostedPageTopInsetProvider>')
  })
})
