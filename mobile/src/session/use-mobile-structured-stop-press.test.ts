import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileStructuredStopPress } from './use-mobile-structured-stop-press'

let renderer: ReactTestRenderer | null = null
let latest: ReturnType<typeof useMobileStructuredStopPress> | null = null

function Probe({ sessionKey }: { sessionKey: string }): null {
  latest = useMobileStructuredStopPress(sessionKey)
  return null
}

function mount(sessionKey = 'session-1'): ReturnType<typeof useMobileStructuredStopPress> {
  act(() => {
    renderer = create(createElement(Probe, { sessionKey }))
  })
  return latest!
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
})

describe("the phone's Stop press read as Stopping", () => {
  it('holds while the request is in flight and clears when it answers', async () => {
    let answer: (value: boolean) => void = () => undefined
    let tracked: Promise<boolean> = Promise.resolve(false)
    const press = mount()
    act(() => {
      tracked = press.track(() => new Promise<boolean>((resolve) => (answer = resolve)))
    })
    expect(latest?.pressed).toBe(true)

    await act(async () => {
      answer(true)
      await tracked
    })
    expect(latest?.pressed).toBe(false)
  })

  it('clears when the request fails', async () => {
    let fail: (error: unknown) => void = () => undefined
    let tracked: Promise<boolean> = Promise.resolve(false)
    const press = mount()
    act(() => {
      tracked = press.track(() => new Promise<boolean>((_, reject) => (fail = reject)))
    })

    await act(async () => {
      fail(new Error('socket closed'))
      await tracked.catch(() => undefined)
    })

    expect(latest?.pressed).toBe(false)
  })
})
