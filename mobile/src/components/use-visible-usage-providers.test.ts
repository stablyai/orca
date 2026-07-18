import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisibleUsageProviders } from './use-visible-usage-providers'

type FocusCallback = () => void | (() => void)

const dependencies = vi.hoisted(() => ({
  focusCallback: null as FocusCallback | null,
  loadVisibleUsageProvidersSettled: vi.fn()
}))

vi.mock('expo-router', () => ({
  useFocusEffect: (callback: FocusCallback) => {
    dependencies.focusCallback = callback
  }
}))

vi.mock('../storage/preferences', () => ({
  loadVisibleUsageProvidersSettled: dependencies.loadVisibleUsageProvidersSettled
}))

function Probe({ onValue }: { onValue: (value: string[]) => void }) {
  onValue([...useVisibleUsageProviders()])
  return null
}

describe('useVisibleUsageProviders', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.focusCallback = null
    dependencies.loadVisibleUsageProvidersSettled.mockReset()
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

  it('starts with Claude and Codex, then reloads the stored set on focus', async () => {
    dependencies.loadVisibleUsageProvidersSettled.mockResolvedValue(
      new Set(['antigravity', 'grok'])
    )
    const values: string[][] = []
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Probe, { onValue: (value) => values.push(value) }))
    })
    expect(values.at(-1)).toEqual(['claude', 'codex'])

    let cleanup: void | (() => void)
    await act(async () => {
      cleanup = dependencies.focusCallback?.()
      await Promise.resolve()
    })
    expect(values.at(-1)).toEqual(['antigravity', 'grok'])

    cleanup?.()
    act(() => renderer?.unmount())
  })

  it('ignores a storage read that resolves after the screen loses focus', async () => {
    let resolveLoad: ((value: Set<string>) => void) | null = null
    dependencies.loadVisibleUsageProvidersSettled.mockImplementation(
      () => new Promise((resolve) => (resolveLoad = resolve))
    )
    const values: string[][] = []
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Probe, { onValue: (value) => values.push(value) }))
    })
    const cleanup = dependencies.focusCallback?.()
    cleanup?.()
    await act(async () => {
      resolveLoad?.(new Set(['grok']))
      await Promise.resolve()
    })

    expect(values.at(-1)).toEqual(['claude', 'codex'])
    act(() => renderer?.unmount())
  })
})
