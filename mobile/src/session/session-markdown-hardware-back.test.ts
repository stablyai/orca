import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows to 'ios' and the tests reassign it.
  const platform: { os: 'ios' | 'android' | 'web' } = { os: 'ios' }
  const remove = vi.fn()
  return {
    platform,
    remove,
    dismiss: vi.fn(),
    addEventListener: vi.fn((_event: string, _handler: () => boolean) => ({ remove }))
  }
})

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, handler: () => boolean) =>
      native.addEventListener(event, handler)
  },
  Keyboard: { dismiss: () => native.dismiss() },
  get Platform() {
    return { OS: native.platform.os }
  }
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('./mobile-session-write-operations', () => ({ markdownTabSave: () => ({}) }))

import {
  useMobileSessionMarkdownActions,
  type MobileSessionMarkdownActionsScope
} from './use-mobile-session-markdown-actions'
import type { MarkdownDocState } from './mobile-session-route-types'

const leaves: { back: (() => void) | null } = { back: null }

/** The three members the hook calls, which is all a probe of it can honestly stand behind. */
const probeRouter = {
  canGoBack: () => true,
  back: () => {
    leaves.back?.()
  },
  replace: () => {}
}

/** A dirty draft is what makes the gate's effect re-register, which is the second half of the gate. */
function scopeWith(markdownDocs: Map<string, MarkdownDocState>): MobileSessionMarkdownActionsScope {
  return {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    /**
     * SAFETY: expo-router's `Router` carries members this probe has no use for, and the hook calls
     * exactly the three above. A call to any other is a TypeError this probe fails on rather than
     * passes through, which is the invariant the assertion stands on.
     */
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stated above.
    router: probeRouter as unknown as MobileSessionMarkdownActionsScope['router'],
    client: null,
    sessionTabs: [],
    markdownDocs,
    setMarkdownDocs: () => {},
    discardMarkdownTarget: null,
    setDiscardMarkdownTarget: () => {},
    setLeaveDrafts: () => {},
    markdownSaveSeqRef: { current: new Map() },
    markdownSaveInFlightRef: { current: new Set() },
    showToast: () => {},
    readMarkdownTab: async () => {}
  }
}

function readyDoc(content: string, localContent: string): MarkdownDocState {
  return {
    status: 'ready',
    content,
    localContent,
    baseVersion: 'v1',
    isDirty: content !== localContent,
    editable: true
  }
}

function Probe({ docs }: { docs: Map<string, MarkdownDocState> }): null {
  useMobileSessionMarkdownActions(scopeWith(docs))
  return null
}

function render(docs: Map<string, MarkdownDocState>): ReturnType<typeof create> {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(createElement(Probe, { docs }))
  })
  if (renderer === null) {
    throw new Error('the probe did not render')
  }
  return renderer
}

beforeEach(() => {
  native.platform.os = 'ios'
  native.addEventListener.mockClear()
  native.remove.mockClear()
  native.dismiss.mockClear()
  leaves.back = null
})

/**
 * The session's own hardware-back registration, which had no unit test of its own (ruling 33.2).
 *
 * Two things were wrong before C7.7 and both are asserted here. React Native Web answers
 * `BackHandler.addEventListener` with "BackHandler is not supported on web and should not be used."
 * and an inert subscription, so inside the shell's page every session mount put that line on the
 * console and armed nothing — and the effect re-registers whenever the dirty-draft list changes,
 * which is why it was two lines and not one.
 */
describe("the session's hardware back gate", () => {
  it('arms the hardware back press natively', () => {
    render(new Map())
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
  })

  it('never arms it on the web, where it is inert and says so on the console', () => {
    native.platform.os = 'web'
    render(new Map())
    expect(native.addEventListener).not.toHaveBeenCalled()
  })

  it('leaves through the router when nothing is dirty', () => {
    render(new Map())
    const handler = native.addEventListener.mock.calls[0]?.[1]
    const left = vi.fn()
    leaves.back = left
    act(() => {
      expect(handler?.()).toBe(true)
    })
    expect(left).toHaveBeenCalledTimes(1)
    expect(native.dismiss).not.toHaveBeenCalled()
  })

  it('asks instead of leaving when a draft is dirty, and dismisses the keyboard to ask', () => {
    render(new Map([['tab-1', readyDoc('saved', 'edited')]]))
    const handler = native.addEventListener.mock.calls[0]?.[1]
    const left = vi.fn()
    leaves.back = left
    act(() => {
      expect(handler?.()).toBe(true)
    })
    expect(left).not.toHaveBeenCalled()
    expect(native.dismiss).toHaveBeenCalledTimes(1)
  })

  it('re-registers when the dirty-draft list changes, and removes what it replaced', () => {
    const renderer = render(new Map())
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    act(() => {
      renderer.update(
        createElement(Probe, { docs: new Map([['tab-1', readyDoc('saved', 'edited')]]) })
      )
    })
    expect(native.addEventListener).toHaveBeenCalledTimes(2)
    expect(native.remove).toHaveBeenCalledTimes(1)
  })

  it('never re-registers on the web, however many times the drafts change', () => {
    native.platform.os = 'web'
    const renderer = render(new Map())
    act(() => {
      renderer.update(
        createElement(Probe, { docs: new Map([['tab-1', readyDoc('saved', 'edited')]]) })
      )
    })
    expect(native.addEventListener).not.toHaveBeenCalled()
    expect(native.remove).not.toHaveBeenCalled()
  })
})
