import { describe, expect, it, vi } from 'vitest'
import type { HostInstance } from 'react-native'
import { hookMount, performHookAction } from '../../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../../test-support/rpc-recording/recorder-fixture-shape'
import { useSessionTitleCard } from './use-session-title-card'
import {
  useAnchoredDetailCard,
  type DetailCardMeasure
} from '../../components/use-anchored-detail-card'

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 400, height: 800 })
}))
vi.mock('../../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 })
}))
vi.mock('../../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))

type Measured = Parameters<HostInstance['measureInWindow']>[0]
function deferredView() {
  let measure!: Measured
  const view = mountFixture<HostInstance>({
    measureInWindow: (callback) => {
      measure = callback
    }
  })
  return {
    view,
    reply: (x: number, y: number, width = 100, height = 40) => measure(x, y, width, height)
  }
}

describe('card window measurements', () => {
  it('places the title after one concurrent measurement batch in either callback order', () => {
    let card!: ReturnType<typeof useSessionTitleCard>
    const layer = deferredView()
    const title = deferredView()
    const bar = deferredView()
    const hook = hookMount(() => {
      card = useSessionTitleCard(false, false)
    })
    hook.mount()
    card.layerRef.current = layer.view
    card.barRef.current = bar.view
    card.titleRef.current = mountFixture<NonNullable<typeof card.titleRef.current>>({
      measureInWindow: title.view.measureInWindow
    })
    try {
      performHookAction(card.toggle)
      // Native callbacks are withheld: all three requests must already exist.
      performHookAction(() => bar.reply(0, 100))
      performHookAction(() => title.reply(100, 100))
      expect(card.active).toBe(false)
      performHookAction(() => layer.reply(20, 40))
      expect(card.visual?.anchor).toEqual({
        side: 'below',
        left: 80,
        top: 100,
        origin: { x: 20, y: 40 }
      })
      performHookAction(card.dismiss)
      performHookAction(card.toggle)
      performHookAction(() => layer.reply(20, 40))
      performHookAction(() => title.reply(100, 100))
      performHookAction(() => bar.reply(0, 100))
      expect(card.visual?.anchor).toEqual({
        side: 'below',
        left: 80,
        top: 100,
        origin: { x: 20, y: 40 }
      })
    } finally {
      hook.unmount()
    }
  })

  it('converts above anchors once and discards measurements after geometry changes', () => {
    let card!: ReturnType<typeof useAnchoredDetailCard>
    let place!: Parameters<DetailCardMeasure>[0]
    const measure: DetailCardMeasure = (next) => {
      place = next
    }
    const layer = deferredView()
    const hook = hookMount(() => {
      card = useAnchoredDetailCard({ obscured: false, measure })
    })
    hook.mount()
    card.layerRef.current = layer.view
    try {
      performHookAction(card.toggle)
      performHookAction(() => place({ side: 'above', right: 380, bottom: 700 }))
      performHookAction(() => layer.reply(20, 40))
      expect(card.visual?.anchor).toEqual({
        side: 'above',
        right: 360,
        bottom: 660,
        origin: { x: 20, y: 40 }
      })
      performHookAction(card.dismiss)
      performHookAction(card.toggle)
      performHookAction(card.onAnchorLayout)
      performHookAction(() => place({ side: 'above', right: 100, bottom: 200 }))
      performHookAction(() => layer.reply(20, 40))
      expect(card.active).toBe(false)
      expect(card.visual?.anchor).toEqual({
        side: 'above',
        right: 360,
        bottom: 660,
        origin: { x: 20, y: 40 }
      })
    } finally {
      hook.unmount()
    }
  })

  it('closes a request with a missing anchor even before the layer replies', () => {
    let card!: ReturnType<typeof useAnchoredDetailCard>
    const layer = deferredView()
    const hook = hookMount(() => {
      card = useAnchoredDetailCard({ obscured: false, measure: (place) => place(null) })
    })
    hook.mount()
    card.layerRef.current = layer.view
    try {
      performHookAction(card.toggle)
      expect(card.requestedOpen).toBe(false)
      performHookAction(() => layer.reply(20, 40))
      expect(card.active).toBe(false)
    } finally {
      hook.unmount()
    }
  })
})
