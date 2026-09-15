import { describe, expect, it } from 'vitest'
import { addRemovableListener } from './add-removable-listener'

describe('addRemovableListener', () => {
  it('removes only its own listener and leaves the order of the rest intact', () => {
    const first = (): void => {}
    const second = (): void => {}
    const third = (): void => {}
    const listeners = [first]
    addRemovableListener(listeners, second)
    const removeThird = addRemovableListener(listeners, third)

    expect(listeners).toEqual([first, second, third])
    removeThird()
    expect(listeners).toEqual([first, second])
  })

  it('is a no-op on a second call rather than dropping the last listener', () => {
    const kept = (): void => {}
    const listeners: (() => void)[] = []
    const remove = addRemovableListener(listeners, () => {})
    remove()
    addRemovableListener(listeners, kept)

    // A second unsubscribe finds indexOf === -1; an unguarded splice(-1, 1) would evict `kept`.
    remove()
    expect(listeners).toEqual([kept])
  })
})
