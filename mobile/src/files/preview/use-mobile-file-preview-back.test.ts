import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // Annotate rather than assert: the tests reassign the initial ios literal.
  const platform: { os: 'ios' | 'android' | 'web' } = { os: 'ios' }
  return {
    platform,
    addEventListener: vi.fn((_event: string, _handler: () => boolean) => ({ remove: vi.fn() }))
  }
})

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, handler: () => boolean) =>
      native.addEventListener(event, handler)
  },
  get Platform() {
    return { OS: native.platform.os }
  }
}))

import {
  useMobileFilePreviewBack,
  type MobileFilePreviewBack
} from './use-mobile-file-preview-back'

const held: { back: MobileFilePreviewBack | null } = { back: null }

function Screen({ hasUnsavedDraft, leave }: { hasUnsavedDraft: boolean; leave: () => void }): null {
  held.back = useMobileFilePreviewBack({ hasUnsavedDraft, leave })
  return null
}

function render(hasUnsavedDraft: boolean, leave: () => void): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Screen, { hasUnsavedDraft, leave }))
  })
  if (!renderer) {
    throw new Error('the probe did not render')
  }
  return renderer
}

beforeEach(() => {
  native.platform.os = 'ios'
  native.addEventListener.mockClear()
  held.back = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('leaving the file preview', () => {
  it('does not re-show itself on the next edit after a save', () => {
    // Saving hides the prompt but must also clear asking, or the next edit reopens it without a Back request.
    const leave = vi.fn()
    const renderer = render(true, leave)
    act(() => {
      held.back?.requestBack()
    })
    expect(held.back?.confirmingDiscard).toBe(true)
    act(() => {
      renderer.update(createElement(Screen, { hasUnsavedDraft: false, leave }))
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    act(() => {
      renderer.update(createElement(Screen, { hasUnsavedDraft: true, leave }))
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })

  // The bundler selects use-back-claim.web.ts for the shell’s Back key; the hook uses one seam on both platforms.
})
