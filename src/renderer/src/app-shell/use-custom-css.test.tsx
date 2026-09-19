// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { CustomCssSnapshot } from '../../../shared/custom-css'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({
  applyCustomCssSheet: vi.fn(),
  buildCustomCssSheet: vi.fn((css: string) => ({ css }))
}))

vi.mock('@/lib/custom-css-sheet', () => ({
  applyCustomCssSheet: mocks.applyCustomCssSheet,
  buildCustomCssSheet: mocks.buildCustomCssSheet
}))

import { useCustomCss } from './use-custom-css'

const initialState = useAppStore.getState()
const snapshot = (css: string): CustomCssSnapshot => ({
  path: '/home/example/.orca/custom.css',
  exists: true,
  css,
  error: null
})

describe('useCustomCss', () => {
  let current: CustomCssSnapshot
  let pushChange: (next: CustomCssSnapshot) => void
  const offChanged = vi.fn()
  const get = vi.fn(async () => current)

  beforeEach(() => {
    vi.clearAllMocks()
    current = snapshot(':root { --background: #111; }')
    Object.assign(window, {
      api: {
        customCss: {
          get,
          onChanged: vi.fn((callback: (next: CustomCssSnapshot) => void) => {
            pushChange = callback
            return offChanged
          })
        }
      }
    })
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), customCssEnabled: true } })
  })

  afterEach(() => {
    // Why: a failed assertion skips the in-test unmount; don't leak the hook into the next test.
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('does nothing while the setting is off', () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), customCssEnabled: false } })
    const { unmount } = renderHook(() => useCustomCss())

    expect(get).not.toHaveBeenCalled()
    expect(mocks.applyCustomCssSheet).not.toHaveBeenCalled()
    unmount()
  })

  it('applies the file, then every pushed change, skipping unchanged contents', async () => {
    const { unmount } = renderHook(() => useCustomCss())
    await waitFor(() =>
      expect(mocks.buildCustomCssSheet).toHaveBeenLastCalledWith(':root { --background: #111; }')
    )

    act(() => pushChange(snapshot(':root { --background: #222; }')))
    expect(mocks.buildCustomCssSheet).toHaveBeenLastCalledWith(':root { --background: #222; }')

    act(() => pushChange(snapshot(':root { --background: #222; }')))
    expect(mocks.buildCustomCssSheet).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('removes the sheet and unsubscribes when turned off', async () => {
    const { unmount } = renderHook(() => useCustomCss())
    await waitFor(() => expect(mocks.buildCustomCssSheet).toHaveBeenCalledOnce())

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, customCssEnabled: false } })
    })
    expect(mocks.applyCustomCssSheet).toHaveBeenLastCalledWith(document, null)
    expect(offChanged).toHaveBeenCalledOnce()
    unmount()
  })
})
