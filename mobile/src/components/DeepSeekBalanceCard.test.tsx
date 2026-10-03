import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekBalanceCard } from './DeepSeekBalanceCard'
import { decodeAccountsSnapshot } from './accounts-snapshot'
import {
  deepSeekMobileSnapshot,
  MOBILE_DEEPSEEK_LIMITS
} from '../test-support/deepseek-balance-snapshot'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({ Coins: 'Coins' }))

describe('mobile DeepSeek balance surfaces', () => {
  const mounted: ReactTestRenderer[] = []
  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount()
      }
    })
    mounted.length = 0
  })
  function render(compact = false, overrides: Record<string, unknown> = {}) {
    const rendered: { current: ReactTestRenderer | null } = { current: null }
    act(() => {
      rendered.current = create(
        createElement(DeepSeekBalanceCard, {
          snapshot: decodeAccountsSnapshot(deepSeekMobileSnapshot(overrides)),
          compact
        })
      )
    })
    const renderer = rendered.current
    if (!renderer) {
      throw new Error('Balance card did not render')
    }
    mounted.push(renderer)
    return renderer
  }
  it('renders exact multi-currency totals and details with polite status updates and no key controls', () => {
    const renderer = render()
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('9007199254740993.00100')
    expect(json).toContain('12.3400')
    expect(json).toContain('Granted')
    expect(json).toContain('Topped up')
    expect(json).toContain('"accessibilityLiveRegion":"polite"')
    expect(json).not.toContain('Pressable')
    expect(json).not.toContain('TextInput')
    expect(json).not.toContain('%')
  })
  it('keeps the Home summary to each currency total', () => {
    const json = JSON.stringify(render(true).toJSON())
    expect(json).toContain('CNY')
    expect(json).toContain('USD')
    expect(json).not.toContain('Granted')
    expect(json).not.toContain('Topped up')
  })
  it('leaves old-host UI unchanged and makes an unavailable configured balance explicit', () => {
    expect(render(false, { deepseekAccount: undefined }).toJSON()).toBeNull()
    const json = JSON.stringify(
      render(false, {
        deepseek: { ...MOBILE_DEEPSEEK_LIMITS, status: 'error', balance: null }
      }).toJSON()
    )
    expect(json).toContain('Balance unavailable')
    expect(json).not.toContain('12.3400')
  })
})
