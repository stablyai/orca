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
  it('leaves straight away when there is nothing to lose', () => {
    const leave = vi.fn()
    render(false, leave)
    act(() => {
      expect(held.back?.requestBack()).toBe(true)
    })
    expect(leave).toHaveBeenCalledTimes(1)
    expect(held.back?.confirmingDiscard).toBe(false)
  })

  it('asks before dropping an unsaved draft, and does not leave while it is asking', () => {
    const leave = vi.fn()
    render(true, leave)
    act(() => {
      expect(held.back?.requestBack()).toBe(true)
    })
    expect(leave).not.toHaveBeenCalled()
    expect(held.back?.confirmingDiscard).toBe(true)
  })

  it('stays on the answer to stay', () => {
    const leave = vi.fn()
    render(true, leave)
    act(() => {
      held.back?.requestBack()
    })
    act(() => {
      held.back?.stay()
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })

  it('leaves once, on the answer to discard', () => {
    const leave = vi.fn()
    render(true, leave)
    act(() => {
      held.back?.requestBack()
    })
    act(() => {
      held.back?.discard()
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('drops the question when the draft it was about is gone', () => {
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
    expect(leave).not.toHaveBeenCalled()
  })

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
  it('registers once across a rebuilt handler, rather than per dependency change', () => {
    const leave = vi.fn()
    const renderer = render(false, leave)
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
    act(() => {
      renderer.update(createElement(Screen, { hasUnsavedDraft: true, leave }))
    })
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    let handled = false
    act(() => {
      handled = native.addEventListener.mock.calls[0]?.[1]?.() ?? false
    })
    expect(handled).toBe(true)
    expect(leave).not.toHaveBeenCalled()
    expect(held.back?.confirmingDiscard).toBe(true)
  })
})
