// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { expect, it, vi } from 'vitest'
import { MobileNativeChatLowerRegion } from '../MobileNativeChatLowerRegion.web'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('lucide-react-native', () => ({}))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: () => null }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: () => null }))
vi.mock('./MobileNativeChatStructuredAsk', () => ({ MobileNativeChatStructuredAsk: () => null }))
vi.mock('./MobileNativeChatPromptStrip', () => ({ MobileNativeChatPromptStrip: () => null }))
vi.mock('../../../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('./MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: () => <button>Pending question</button>
}))

it('reveals a question already pending when the lower region mounts', async () => {
  const observers = new Set<ResizeObserver>()
  const deliver = new Map<ResizeObserver, () => void>()
  class LayoutObserver implements ResizeObserver {
    private nodes = new Set<Element>()
    constructor(callback: ResizeObserverCallback) {
      observers.add(this)
      deliver.set(this, () =>
        callback(
          Array.from(this.nodes, (target): ResizeObserverEntry => ({
            target,
            contentRect: target.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: []
          })),
          this
        )
      )
    }
    observe(node: Element) {
      this.nodes.add(node)
    }
    unobserve(node: Element) {
      this.nodes.delete(node)
    }
    disconnect() {
      this.nodes.clear()
    }
  }
  vi.stubGlobal('ResizeObserver', LayoutObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, 300, this.dataset.testid === 'native-chat-view' ? 600 : 200)
  })
  vi.useFakeTimers()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const hidden = () => {
    for (
      let node: HTMLElement | null = container.querySelector('button');
      node;
      node = node.parentElement
    ) {
      if (getComputedStyle(node).opacity === '0') {
        return true
      }
    }
    return false
  }
  try {
    await act(async () =>
      root.render(
        <div data-testid="native-chat-view">
          <MobileNativeChatLowerRegion>
            <MobileNativeChatPromptCard
              question={{
                question: 'Continue?',
                options: [],
                optionTokens: [],
                multiSelect: false
              }}
            />
          </MobileNativeChatLowerRegion>
        </div>
      )
    )
    expect(container.querySelector('button')).not.toBeNull()
    expect(hidden()).toBe(true)
    await act(async () => {
      for (const observer of observers) {
        deliver.get(observer)?.()
      }
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(hidden()).toBe(false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
