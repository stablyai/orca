import { describe, expect, it, vi } from 'vitest'
import {
  createScreencastFrameAckWindow,
  screencastFrameAckWindowSize
} from './browser-screencast-frame-ack-window'

function harness(size = 2) {
  let clock = 0
  const timers: { at: number; callback: () => void }[] = []
  const onOpen = vi.fn()
  const window = createScreencastFrameAckWindow({
    size,
    onOpen,
    timeoutMs: 2_000,
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, callback }
      timers.push(timer)
      return () => timers.splice(timers.indexOf(timer), 1)
    }
  })
  const advance = (ms: number) => {
    clock += ms
    for (const timer of timers.filter((t) => t.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.callback()
    }
  }
  const delivered: number[] = []
  const send = (seq: number, accepted = true) =>
    window.send(seq, () => {
      if (accepted) {
        delivered.push(seq)
      }
      return accepted
    })
  return { window, onOpen, advance, delivered, send }
}

describe('createScreencastFrameAckWindow', () => {
  it('lets the window fill, refuses the next frame, and reopens on an ack', () => {
    const { window, onOpen, send, delivered } = harness()
    expect([send(1), send(2), send(3)]).toEqual([true, true, false])
    expect(delivered).toEqual([1, 2])
    window.ack(1)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(send(3)).toBe(true)
  })

  it('treats an ack as covering every earlier frame', () => {
    const { window, send } = harness()
    send(1)
    send(2)
    window.ack(2)
    expect([send(3), send(4)]).toEqual([true, true])
  })

  it('does not count a frame the socket refused', () => {
    const { send } = harness(1)
    expect(send(1, false)).toBe(false)
    expect(send(2)).toBe(true)
  })

  it('stops waiting for an ack lost on the way and offers the kept frame again', () => {
    const { onOpen, send, advance } = harness(1)
    send(1)
    expect(send(2)).toBe(false)
    advance(1_999)
    expect(onOpen).not.toHaveBeenCalled()
    advance(1)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(send(2)).toBe(true)
  })

  it('stays quiet when nothing was refused', () => {
    const { window, onOpen, send } = harness()
    send(1)
    window.ack(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('is off unless the viewer asks for a window, and capped', () => {
    expect([undefined, 0, Number.NaN].map(screencastFrameAckWindowSize)).toEqual([null, null, null])
    expect(screencastFrameAckWindowSize(2.7)).toBe(2)
    expect(screencastFrameAckWindowSize(100)).toBe(8)
  })
})
