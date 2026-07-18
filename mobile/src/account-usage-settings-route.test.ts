import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountUsageSettingsScreen from '../app/account-usage-settings'

const dependencies = vi.hoisted(() => ({
  back: vi.fn(),
  loadVisibleUsageProvidersSettled: vi.fn(),
  setUsageProviderVisible: vi.fn()
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: dependencies.back })
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft'
}))

vi.mock('./storage/preferences', () => ({
  loadVisibleUsageProvidersSettled: dependencies.loadVisibleUsageProvidersSettled,
  setUsageProviderVisible: dependencies.setUsageProviderVisible
}))

async function renderRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(AccountUsageSettingsScreen))
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Account usage settings route did not render')
  }
  return renderer
}

describe('account usage settings route', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.loadVisibleUsageProvidersSettled
      .mockReset()
      .mockResolvedValue(new Set(['claude', 'codex']))
    dependencies.setUsageProviderVisible.mockReset().mockResolvedValue(new Set(['claude', 'codex']))
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes all eight provider switches with stable accessible names', async () => {
    const renderer = await renderRoute()
    const back = renderer.root.findAllByType('Pressable')[0]
    const switches = renderer.root.findAllByType('Switch')

    expect(back?.props).toMatchObject({ accessibilityLabel: 'Back', accessibilityRole: 'button' })
    expect(switches.map((item) => item.props.accessibilityLabel)).toEqual([
      'Show Claude usage',
      'Show Codex usage',
      'Show Gemini usage',
      'Show Antigravity usage',
      'Show OpenCode Go usage',
      'Show Kimi usage',
      'Show MiniMax usage',
      'Show Grok usage'
    ])

    act(() => renderer.unmount())
  })

  it('rolls an optimistic toggle back when persistence fails', async () => {
    dependencies.setUsageProviderVisible.mockRejectedValueOnce(new Error('storage unavailable'))
    const renderer = await renderRoute()
    const antigravity = () =>
      renderer.root
        .findAllByType('Switch')
        .find((item) => item.props.accessibilityLabel === 'Show Antigravity usage')

    expect(antigravity()?.props.value).toBe(false)
    await act(async () => {
      antigravity()?.props.onValueChange(true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.setUsageProviderVisible).toHaveBeenCalledWith('antigravity', true)
    expect(dependencies.loadVisibleUsageProvidersSettled).toHaveBeenCalledTimes(2)
    expect(antigravity()?.props.value).toBe(false)

    act(() => renderer.unmount())
  })
})
