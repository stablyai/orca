import { createElement, Suspense } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'

let focusCleanup: (() => void) | undefined

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    focusCleanup = effect() ?? undefined
  }
}))

describe('mobile send completion generation', () => {
  it('invalidates completions on a surface change and retained-route blur', () => {
    const onBlur = vi.fn()
    let getGeneration: (() => number) | null = null
    let renderer: ReactTestRenderer

    function Harness({ surfaceKey }: { surfaceKey: string }): null {
      getGeneration = useMobileSendCompletionGeneration({ onBlur, surfaceKey })
      return null
    }

    act(() => {
      renderer = create(createElement(Harness, { surfaceKey: 'tab-a' }))
    })
    const initialGeneration = getGeneration!()
    act(() => {
      renderer.update(createElement(Harness, { surfaceKey: 'tab-b' }))
    })
    expect(getGeneration!()).toBeGreaterThan(initialGeneration)

    const surfaceGeneration = getGeneration!()
    act(() => focusCleanup?.())
    expect(getGeneration!()).toBeGreaterThan(surfaceGeneration)
    expect(onBlur).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('does not invalidate the committed surface during a suspended render', () => {
    const never = new Promise<never>(() => undefined)
    let getGeneration: (() => number) | null = null
    let renderer: ReactTestRenderer

    function Harness({ surfaceKey, suspend }: { surfaceKey: string; suspend: boolean }): null {
      getGeneration = useMobileSendCompletionGeneration({ onBlur: vi.fn(), surfaceKey })
      if (suspend) {
        throw never
      }
      return null
    }

    act(() => {
      renderer = create(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Harness, { surfaceKey: 'tab-a', suspend: false })
        )
      )
    })
    const committedGeneration = getGeneration!()
    act(() => {
      renderer.update(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Harness, { surfaceKey: 'tab-b', suspend: true })
        )
      )
    })

    expect(getGeneration!()).toBe(committedGeneration)
    act(() => renderer.unmount())
  })
})
