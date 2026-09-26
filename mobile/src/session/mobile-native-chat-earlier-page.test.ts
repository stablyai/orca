import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import {
  createMobileEarlierPageGate,
  shouldRequestMobileEarlierPage,
  type MobileEarlierPageSample
} from './mobile-native-chat-earlier-page'
import { useMobileEarlierPageGate } from './use-mobile-native-chat-earlier-page'

function sample(overrides: Partial<MobileEarlierPageSample> = {}): MobileEarlierPageSample {
  return {
    offsetY: 40,
    previousOffsetY: 120,
    historyHeadId: 'm40',
    requestedAtHistoryHeadId: null,
    hasRequested: false,
    hasMore: true,
    loadingEarlier: false,
    ...overrides
  }
}

describe('shouldRequestMobileEarlierPage', () => {
  it('requests while the reader is scrolling up into the top edge', () => {
    expect(shouldRequestMobileEarlierPage(sample())).toBe(true)
  })

  it('allows the first near-top sample before a previous offset exists', () => {
    expect(shouldRequestMobileEarlierPage(sample({ previousOffsetY: null }))).toBe(true)
  })

  it('does not request again until older history is inserted', () => {
    expect(
      shouldRequestMobileEarlierPage(
        sample({ hasRequested: true, requestedAtHistoryHeadId: 'm40' })
      )
    ).toBe(false)
  })

  it('does not treat a rendered-row change as earlier history', () => {
    const requested = sample({ hasRequested: true, requestedAtHistoryHeadId: 'm40' })
    expect(shouldRequestMobileEarlierPage(requested)).toBe(false)
    expect(shouldRequestMobileEarlierPage({ ...requested, historyHeadId: 'm0' })).toBe(true)
  })

  it('does not request while the offset is holding or moving down', () => {
    expect(shouldRequestMobileEarlierPage(sample({ previousOffsetY: 40 }))).toBe(false)
    expect(shouldRequestMobileEarlierPage(sample({ previousOffsetY: 20 }))).toBe(false)
  })

  it('does not request away from the top, without more history, or while a page is loading', () => {
    expect(shouldRequestMobileEarlierPage(sample({ offsetY: 60 }))).toBe(false)
    expect(shouldRequestMobileEarlierPage(sample({ hasMore: false }))).toBe(false)
    expect(shouldRequestMobileEarlierPage(sample({ loadingEarlier: true }))).toBe(false)
  })
})

describe('createMobileEarlierPageGate', () => {
  it('fires once for a scroll into the top edge and again only after the oldest row changes', () => {
    const gate = createMobileEarlierPageGate()
    const base = { hasMore: true, loadingEarlier: false, historyHeadId: 'm40' }
    expect(gate.observe({ ...base, offsetY: 80 })).toBe(false)
    expect(gate.observe({ ...base, offsetY: 40 })).toBe(true)
    expect(gate.observe({ ...base, offsetY: 20 })).toBe(false)
    expect(gate.observe({ ...base, offsetY: 30 })).toBe(false)
    expect(gate.observe({ ...base, offsetY: 50, historyHeadId: 'm0' })).toBe(false)
    expect(gate.observe({ ...base, offsetY: 20, historyHeadId: 'm0' })).toBe(true)
  })
})

describe('useMobileEarlierPageGate', () => {
  let renderer: ReactTestRenderer | null = null
  let gate: ReturnType<typeof createMobileEarlierPageGate> | null = null

  function Probe({ surfaceId }: { surfaceId: string }) {
    gate = useMobileEarlierPageGate(surfaceId)
    return null
  }

  it('lets the next chat request on its first near-top scroll', async () => {
    await act(async () => {
      renderer = create(createElement(Probe, { surfaceId: 'tab-a' }))
    })
    const base = { hasMore: true, loadingEarlier: false, historyHeadId: 'm1' }
    expect(gate!.observe({ ...base, offsetY: 40 })).toBe(true)
    expect(gate!.observe({ ...base, offsetY: 10 })).toBe(false)

    await act(async () => {
      renderer?.update(createElement(Probe, { surfaceId: 'tab-b' }))
    })

    expect(gate!.observe({ ...base, offsetY: 30 })).toBe(true)
    act(() => renderer?.unmount())
    renderer = null
  })
})
