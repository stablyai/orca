import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlowPendingKeys } from './use-slow-pending-keys'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

let latest: ReadonlySet<string> = new Set()
function Probe({ pending }: { pending: ReadonlySet<string> }) {
  latest = useSlowPendingKeys(pending)
  return null
}

function mount(pending: ReadonlySet<string>): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe, { pending }))
  })
  if (!renderer) {
    throw new Error('not mounted')
  }
  return renderer
}

function update(renderer: ReactTestRenderer, pending: ReadonlySet<string>): void {
  act(() => renderer.update(createElement(Probe, { pending })))
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useSlowPendingKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    unmountRenderers()
    vi.useRealTimers()
  })

  it('shows a key only once it has been pending for 500 ms', () => {
    mount(new Set(['a']))
    expect([...latest]).toEqual([])
    advance(499)
    expect([...latest]).toEqual([])
    advance(1)
    expect([...latest]).toEqual(['a'])
  })

  it('never shows a key the desktop answers within 500 ms', () => {
    const renderer = mount(new Set(['a']))
    advance(300)
    update(renderer, new Set())
    advance(1_000)
    expect([...latest]).toEqual([])
  })

  it('hides a slow key on the render it settles', () => {
    const renderer = mount(new Set(['a']))
    advance(500)
    expect([...latest]).toEqual(['a'])
    update(renderer, new Set())
    expect([...latest]).toEqual([])
  })

  it('times each key from when it first went pending, across re-renders', () => {
    const renderer = mount(new Set(['a']))
    advance(300)
    update(renderer, new Set(['a', 'b']))
    advance(200)
    expect([...latest]).toEqual(['a'])
    advance(300)
    expect([...latest].sort()).toEqual(['a', 'b'])
  })

  it('waits out the delay afresh for a key that settles and goes pending again', () => {
    const renderer = mount(new Set(['a']))
    advance(600)
    update(renderer, new Set())
    update(renderer, new Set(['a']))
    expect([...latest]).toEqual([])
    advance(499)
    expect([...latest]).toEqual([])
    advance(1)
    expect([...latest]).toEqual(['a'])
  })
})
