import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { selectWarmTerminalHandles, useWarmTerminalHandles } from './use-warm-terminal-handles'

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

describe('useWarmTerminalHandles', () => {
  it('retains visible handles plus up to three most recently visible inactive handles', () => {
    const terminals = ['t1', 't2', 't3', 't4', 't5'].map((handle) => ({ handle }))
    let warm: ReadonlySet<string> = new Set()
    function Probe({ active }: { active: string }) {
      warm = useWarmTerminalHandles(terminals, [active], active)
      return null
    }

    act(() => {
      renderer = create(createElement(Probe, { active: 't1' }))
    })
    expect([...warm]).toEqual(['t1'])

    for (const next of ['t2', 't3', 't4', 't5']) {
      act(() => {
        renderer!.update(createElement(Probe, { active: next }))
      })
    }

    // Active t5 + warm inactive t4, t3, t2 stay mounted; oldest t1 is evicted.
    expect(warm.has('t5')).toBe(true)
    expect(warm.has('t4')).toBe(true)
    expect(warm.has('t3')).toBe(true)
    expect(warm.has('t2')).toBe(true)
    expect(warm.has('t1')).toBe(false)
  })

  it('ignores closed handles that are no longer in liveHandles', () => {
    const warm = selectWarmTerminalHandles({
      liveHandles: ['t2', 't3'],
      visibleHandles: ['t3'],
      recentHandles: ['t1', 't2']
    })
    expect([...warm]).toEqual(['t3', 't2'])
  })
})
