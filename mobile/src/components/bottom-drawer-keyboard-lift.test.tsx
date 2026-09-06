import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('react-native-reanimated', () => ({
  withTiming: (value: number, config: { duration: number }) => ({ animated: value, ...config })
}))

import { useBottomDrawerKeyboardLift } from './bottom-drawer-keyboard-lift'

type Offset = { value: number | { animated: number; duration: number } }

describe('bottom drawer keyboard lift', () => {
  let renderer: ReactTestRenderer | null = null
  const offset: Offset = { value: 0 }
  const setKeyboardInset = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    offset.value = 0
    setKeyboardInset.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  type ProbeProps = {
    ridesKeyboard: boolean
    height: number
    duration: number
    setInset?: (inset: number) => void
  }

  // Why one stable component type: a fresh inline component per update remounts the tree and
  // resets the hook's refs, which would hide the very seeding behaviour under test.
  function Probe(props: ProbeProps): null {
    useBottomDrawerKeyboardLift({
      ridesKeyboard: props.ridesKeyboard,
      bottomInset: 34,
      fillAvailable: false,
      keyboard: { height: props.height, duration: props.duration },
      keyboardOffset: offset as { value: number },
      setKeyboardInset: props.setInset ?? setKeyboardInset
    })
    return null
  }

  function render(props: ProbeProps): void {
    const element = createElement(Probe, props)
    act(() => {
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it('seeds an already-raised keyboard instantly, with no transition to join', () => {
    render({ ridesKeyboard: true, height: 300, duration: 250 })

    expect(offset.value).toBe(266)
    expect(setKeyboardInset).toHaveBeenLastCalledWith(266)
  })

  // Why: the drawer used to snap to the bottom on dismiss because the height-change effect's
  // cleanup zeroed the offset before the new height could animate.
  it('animates the dismissal down instead of snapping to the bottom', () => {
    render({ ridesKeyboard: true, height: 0, duration: 0 })
    render({ ridesKeyboard: true, height: 300, duration: 250 })
    expect(offset.value).toEqual({ animated: 266, duration: 250 })

    render({ ridesKeyboard: true, height: 0, duration: 250 })

    expect(offset.value).toEqual({ animated: 0, duration: 250 })
  })

  it('animates a mid-session height change rather than flashing down then up', () => {
    render({ ridesKeyboard: true, height: 0, duration: 0 })
    render({ ridesKeyboard: true, height: 300, duration: 250 })
    render({ ridesKeyboard: true, height: 340, duration: 200 })

    expect(offset.value).toEqual({ animated: 306, duration: 200 })
  })

  // Why: the hook keeps its targets in a ref so a re-created setter cannot re-run the lift
  // effects. That ref now syncs in an effect, which must land before the lift effects of the
  // same commit or the drawer would report its inset to the previous render's owner.
  it('reports the inset to the setter from the same render as the height change', () => {
    const first = vi.fn()
    const second = vi.fn()
    render({ ridesKeyboard: true, height: 0, duration: 0, setInset: first })

    render({ ridesKeyboard: true, height: 300, duration: 250, setInset: second })

    expect(second).toHaveBeenLastCalledWith(266)
    expect(first).not.toHaveBeenCalledWith(266)
  })

  it('drops the lift for a sheet pinned under a picker', () => {
    render({ ridesKeyboard: true, height: 300, duration: 250 })

    render({ ridesKeyboard: false, height: 300, duration: 250 })

    expect(offset.value).toBe(0)
    expect(setKeyboardInset).toHaveBeenLastCalledWith(0)
  })
})
