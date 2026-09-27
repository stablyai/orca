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

const leaves: { back: (() => void) | null; replaced: string[] } = { back: null, replaced: [] }

/** The three members the hook calls, which is all a probe of it can honestly stand behind. */
const probeRouter: { canGoBack: () => boolean; back: () => void; replace: (href: string) => void } =
  {
    canGoBack: () => true,
    back: () => {
      leaves.back?.()
    },
    replace: (href: string) => {
      leaves.replaced.push(href)
    }
  }

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
  leaves.replaced = []
})

/**
 * The session's native claim on the device Back key, which had no unit test of its own (ruling
 * 33.2). Held always natively, dirty or not: the page half, claimed only while a draft is dirty, is
 * `session-markdown-page-back.test.ts`.
 */
describe("the session's hardware back gate", () => {
  it('arms the hardware back press natively, with nothing dirty', () => {
    render(new Map())
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
  })

  it('arms it on Android too', () => {
    native.platform.os = 'android'
    render(new Map())
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
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

  // Why the claim is held while clean: unclaimed at the root, the key would exit the app.
  it('replaces to the host at the root rather than handing the key on', () => {
    probeRouter.canGoBack = () => false
    try {
      render(new Map())
      const handler = native.addEventListener.mock.calls[0]?.[1]
      act(() => {
        expect(handler?.()).toBe(true)
      })
      expect(leaves.replaced).toEqual(['/h/host-1'])
    } finally {
      probeRouter.canGoBack = () => true
    }
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

  it('registers once as the drafts change, and the newest drafts are what a press reads', () => {
    const renderer = render(new Map())
    act(() => {
      renderer.update(
        createElement(Probe, { docs: new Map([['tab-1', readyDoc('saved', 'edited')]]) })
      )
    })
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.remove).not.toHaveBeenCalled()
    const left = vi.fn()
    leaves.back = left
    act(() => {
      expect(native.addEventListener.mock.calls[0]?.[1]?.()).toBe(true)
    })
    expect(left).not.toHaveBeenCalled()
    expect(native.dismiss).toHaveBeenCalledTimes(1)
  })

  it('lets the key go on unmount', () => {
    const renderer = render(new Map())
    act(() => renderer.unmount())
    expect(native.remove).toHaveBeenCalledTimes(1)
  })
})
