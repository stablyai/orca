import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPreviousCrashSession: vi.fn().mockResolvedValue({
    openedAt: '2026-08-24T18:00:00.000Z',
    breadcrumbs: [],
    endedAbnormally: true
  })
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios', Version: '26.5' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  Activity: 'Activity',
  AlertTriangle: 'AlertTriangle',
  CheckCircle2: 'CheckCircle2',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronUp: 'ChevronUp',
  ScrollText: 'ScrollText',
  XCircle: 'XCircle'
}))
vi.mock('../transport/host-store', () => ({ loadHosts: vi.fn().mockResolvedValue([]) }))
vi.mock('../diagnostics/diagnostic-fetch-timeout', () => ({
  startDiagnosticFetchTimeout: () => ({ signal: undefined, dispose: vi.fn() })
}))
vi.mock('../diagnostics/host-reachability', () => ({
  formatEndpoint: vi.fn(),
  testHostReachability: vi.fn(),
  unreachableHostDetail: vi.fn()
}))
vi.mock('../diagnostics/troubleshoot-common-issues', () => ({
  troubleshootCommonIssues: []
}))
vi.mock('../diagnostics/mobile-crash-diagnostics', () => ({
  buildMobileCrashDiagnosticsReport: vi.fn().mockResolvedValue('report'),
  getPreviousMobileCrashSession: mocks.getPreviousCrashSession
}))

import TroubleshootScreen from '../../app/troubleshoot'

describe('TroubleshootScreen crash diagnostics', () => {
  it('shows when the previous session ended abnormally', async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(TroubleshootScreen), { createNodeMock: () => ({}) })
      await Promise.resolve()
    })

    expect(mocks.getPreviousCrashSession).toHaveBeenCalledOnce()
    expect(renderer.root.findByProps({ testID: 'previous-crash-session-banner' })).toBeDefined()
  })
})
