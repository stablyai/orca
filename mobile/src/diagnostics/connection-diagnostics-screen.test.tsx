import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionDiagnosticsScreen } from './connection-diagnostics-screen'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'
import type { DiagnosticsSnapshot } from '../../../src/shared/mobile-web/diagnostics-device-contract'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback])
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Copy: 'Icon',
  Check: 'Icon',
  Send: 'Icon'
}))
vi.mock('../components/ConnectionLog', () => ({ ConnectionLog: () => null }))

const SNAPSHOT: DiagnosticsSnapshot = {
  state: 'disconnected',
  reconnectAttempts: 3,
  lastConnectedAt: null,
  activePath: 'lan',
  pendingPath: null,
  endpointIsTailscale: false,
  platform: 'ios 18',
  appVersion: '1.0.0',
  desktopAppVersion: '2.0.0',
  entries: [],
  mobileWeb: {}
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function device(overrides: Partial<DiagnosticsDeviceOperations> = {}) {
  return {
    snapshot: vi.fn().mockResolvedValue(SNAPSHOT),
    probe: vi.fn().mockResolvedValue({ reachable: true }),
    submit: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  } as unknown as DiagnosticsDeviceOperations
}

async function mount(props: Parameters<typeof ConnectionDiagnosticsScreen>[0]) {
  await act(async () => {
    renderer = create(createElement(ConnectionDiagnosticsScreen, props))
  })
}

function texts(): string[] {
  return renderer!.root
    .findAllByType('Text')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
}

describe('shared connection diagnostics screen', () => {
  it('reports either host through one device operations seam', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const operations = device()
    await mount({
      device: operations,
      hostName: 'Desk',
      writeClipboard: write,
      onBack: () => {}
    })

    expect(texts()).toContain('disconnected')
    expect(texts()).toContain(' · attempt 3')
    expect(operations.snapshot).toHaveBeenCalled()
    await act(async () => {
      await renderer!.root.findAllByType('Pressable')[1]!.props.onPress()
    })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('2.0.0'))
  })

  it('surfaces a device failure instead of a permanent loading state', async () => {
    await mount({
      device: device({ snapshot: vi.fn().mockRejectedValue(new Error('unreachable')) }),
      hostName: 'Desk',
      writeClipboard: vi.fn(),
      onBack: () => {}
    })

    expect(texts().some((text) => text.includes('Could not load network diagnostics'))).toBe(true)
  })

  it('renders no host rather than loading when no host is selected', async () => {
    await mount({ device: null, hostName: null, writeClipboard: vi.fn(), onBack: () => {} })

    expect(texts()).not.toContain('Loading network diagnostics…')
  })
})
