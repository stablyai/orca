// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import {
  resetWindowVisibilityActionsSelectorCacheForTest,
  selectWindowVisibilityActions,
  type WindowVisibilityActions
} from './window-visibility-actions-selector'

function makeActions(): WindowVisibilityActions {
  return {
    refreshAllGitHub: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    bumpGitHubPRVisibleRefreshGeneration: vi.fn()
  }
}

describe('window visibility action selector', () => {
  it('reuses one action bundle across repeated store reads', () => {
    resetWindowVisibilityActionsSelectorCacheForTest()
    const actions = makeActions()
    const first = selectWindowVisibilityActions(actions)

    for (let read = 0; read < 1_000; read += 1) {
      expect(selectWindowVisibilityActions(actions)).toBe(first)
    }
  })

  it('rebuilds the bundle when an action reference changes', () => {
    resetWindowVisibilityActionsSelectorCacheForTest()
    const actions = makeActions()
    const first = selectWindowVisibilityActions(actions)
    const replacement = { ...actions, refreshAllGitHub: vi.fn() }

    const next = selectWindowVisibilityActions(replacement)
    expect(next).not.toBe(first)
    expect(selectWindowVisibilityActions(replacement)).toBe(next)
  })

  it('does not rerender a subscriber for unrelated store writes', () => {
    resetWindowVisibilityActionsSelectorCacheForTest()
    const store = createStore<WindowVisibilityActions & { unrelated: number }>(() => ({
      ...makeActions(),
      unrelated: 0
    }))
    let renderCount = 0
    const view = renderHook(() => {
      renderCount += 1
      return useStore(store, selectWindowVisibilityActions)
    })
    const initialRenderCount = renderCount

    act(() => {
      for (let write = 1; write <= 1_000; write += 1) {
        store.setState({ unrelated: write })
      }
    })

    expect(renderCount).toBe(initialRenderCount)
    view.unmount()
  })
})
