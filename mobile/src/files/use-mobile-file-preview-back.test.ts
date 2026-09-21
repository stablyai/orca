import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows to 'ios' and the tests reassign it.
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
    // A save lands while the prompt is up: there is nothing left to discard, and a prompt still
    // offering to throw work away would be offering to throw away nothing.
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
    // `asking` outlives the draft it was about unless something clears it: with the prompt up, a
    // save makes `hasUnsavedDraft` false and the prompt hides, but the flag is still set, so the
    // very next edit puts the prompt back with no Back request behind it.
    const leave = vi.fn()
    const renderer = render(true, leave)
    act(() => {
      held.back?.requestBack()
    })
    expect(held.back?.confirmingDiscard).toBe(true)
    // The save lands: nothing left to discard.
    act(() => {
      renderer.update(createElement(Screen, { hasUnsavedDraft: false, leave }))
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    // The next edit. Nobody asked to leave, so nobody should be asked about it.
    act(() => {
      renderer.update(createElement(Screen, { hasUnsavedDraft: true, leave }))
    })
    expect(held.back?.confirmingDiscard).toBe(false)
    expect(leave).not.toHaveBeenCalled()
  })

  it('arms the hardware back press natively', () => {
    render(false, vi.fn())
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
  })

  it('never arms it on the web, where it is inert and says so on the console', () => {
    native.platform.os = 'web'
    render(false, vi.fn())
    expect(native.addEventListener).not.toHaveBeenCalled()
  })
})
