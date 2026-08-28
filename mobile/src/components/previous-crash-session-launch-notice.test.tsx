import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn().mockResolvedValue(undefined),
  getUndismissed: vi.fn(),
  push: vi.fn()
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('lucide-react-native', () => ({
  AlertTriangle: 'AlertTriangle',
  ChevronRight: 'ChevronRight',
  X: 'X'
}))
vi.mock('../diagnostics/mobile-crash-diagnostics', () => ({
  dismissPreviousMobileCrashSession: mocks.dismiss,
  getUndismissedPreviousMobileCrashSession: mocks.getUndismissed
}))

import { PreviousCrashSessionLaunchNotice } from './PreviousCrashSessionLaunchNotice'

const previousCrash = {
  openedAt: '2026-08-24T18:00:00.000Z',
  breadcrumbs: [],
  endedAbnormally: true
}

describe('PreviousCrashSessionLaunchNotice', () => {
  beforeEach(() => {
    mocks.dismiss.mockClear()
    mocks.getUndismissed.mockReset()
    mocks.push.mockClear()
  })

  it('shows an abnormal-session report on launch and opens Troubleshooting', async () => {
    mocks.getUndismissed.mockResolvedValue(previousCrash)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(PreviousCrashSessionLaunchNotice))
      await Promise.resolve()
    })

    expect(renderer.root.findByProps({ testID: 'previous-crash-session-banner' })).toBeDefined()
    const open = renderer.root.findByProps({ accessibilityLabel: 'View crash diagnostics' })
    await act(async () => open.props.onPress())

    expect(mocks.dismiss).toHaveBeenCalledWith(previousCrash.openedAt)
    expect(mocks.push).toHaveBeenCalledWith('/troubleshoot')
  })

  it('does not add a launch surface when there is no report', async () => {
    mocks.getUndismissed.mockResolvedValue(null)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(PreviousCrashSessionLaunchNotice))
      await Promise.resolve()
    })

    expect(renderer.root.findAllByProps({ testID: 'previous-crash-session-banner' })).toHaveLength(
      0
    )
  })

  it('describes a contained-then-clean session without calling it abnormal', async () => {
    mocks.getUndismissed.mockResolvedValue({ ...previousCrash, endedAbnormally: false })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(PreviousCrashSessionLaunchNotice))
      await Promise.resolve()
    })

    expect(
      renderer.root.findByProps({ children: 'Previous session recovered from a render error' })
    ).toBeDefined()
    expect(
      renderer.root.findAllByProps({ children: 'Previous session ended abnormally' })
    ).toHaveLength(0)
  })
})
