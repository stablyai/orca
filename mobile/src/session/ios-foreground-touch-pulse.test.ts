import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIosForegroundTouchPulse } from './ios-foreground-touch-pulse'

vi.mock('react-native', () => ({
  View: 'View'
}))

function Probe({ epoch, enabled }: { epoch: number; enabled: boolean }) {
  const committed = useIosForegroundTouchPulse(epoch, enabled)
  return createElement('View', { committed, pointerEvents: committed && enabled ? 'auto' : 'none' })
}

describe('useIosForegroundTouchPulse', () => {
  let renderer: ReactTestRenderer | null = null
  const frames: Array<FrameRequestCallback> = []

  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {}
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  function committed(): boolean {
    return renderer!.root.findByType('View').props.committed as boolean
  }

  function pointerEvents(): string {
    return renderer!.root.findByType('View').props.pointerEvents as string
  }

  it('drops pointerEvents for one frame when the kick epoch advances', () => {
    act(() => {
      renderer = create(createElement(Probe, { epoch: 1, enabled: true }))
    })
    expect(committed()).toBe(false)
    expect(pointerEvents()).toBe('none')

    act(() => {
      frames[0]?.(0)
    })
    expect(committed()).toBe(true)
    expect(pointerEvents()).toBe('auto')
  })

  it('does not pulse when the pane is inactive', () => {
    act(() => {
      renderer = create(createElement(Probe, { epoch: 1, enabled: false }))
    })
    expect(committed()).toBe(true)
    expect(pointerEvents()).toBe('none')
    expect(frames).toHaveLength(0)
  })

  it('does not pulse when no kick has been armed', () => {
    act(() => {
      renderer = create(createElement(Probe, { epoch: 0, enabled: true }))
    })
    expect(committed()).toBe(true)
    expect(pointerEvents()).toBe('auto')
    expect(frames).toHaveLength(0)
  })
})
