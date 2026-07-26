import { describe, expect, it, vi } from 'vitest'
import { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { DaemonTransientFact } from './types'

function createRelay() {
  const emitted: { sessionId: string; fact: DaemonTransientFact }[] = []
  const relay = new BackgroundTransientFactRelay((sessionId, fact) =>
    emitted.push({ sessionId, fact })
  )
  return { relay, emitted }
}

describe('BackgroundTransientFactRelay', () => {
  it('emits a bell fact for a backgrounded session', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', 'build output\x07more')
    expect(emitted).toEqual([{ sessionId: 's1', fact: { kind: 'bell' } }])
  })

  it('keeps OSC escape state across chunks — a title terminator BEL is not a bell', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', '\x1b]0;my working title')
    relay.onSessionData('s1', ' continued\x07')
    expect(emitted).toEqual([])
  })

  it('emits nothing for sessions that are not backgrounded', () => {
    const { relay, emitted } = createRelay()
    relay.onSessionData('s1', 'ding\x07')
    expect(emitted).toEqual([])
  })

  it('emits command-finished with the OSC 133;D exit code', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', '\x1b]133;D;0\x07')
    expect(emitted).toEqual([{ sessionId: 's1', fact: { kind: 'command-finished', exitCode: 0 } }])
  })

  it('stops emitting after un-background and reports the toggle as a state change', () => {
    const { relay, emitted } = createRelay()
    expect(relay.setSessionBackground('s1', true)).toBe(true)
    expect(relay.setSessionBackground('s1', true)).toBe(false)
    expect(relay.setSessionBackground('s1', false)).toBe(true)
    expect(relay.setSessionBackground('s1', false)).toBe(false)
    relay.onSessionData('s1', 'ding\x07')
    expect(emitted).toEqual([])
  })

  it('drops the tracker on session exit', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.onSessionExit('s1')
    expect(relay.isBackgrounded('s1')).toBe(false)
    relay.onSessionData('s1', 'ding\x07')
    expect(emitted).toEqual([])
  })

  it('never arms the stale-working-title timer (titles are main-authoritative)', () => {
    vi.useFakeTimers()
    try {
      const { relay, emitted } = createRelay()
      relay.setSessionBackground('s1', true)
      // A working-spinner title followed by title-less output would arm the
      // 3s stale timer if titles were being tracked.
      relay.onSessionData('s1', '\x1b]0;⠋ Claude\x07')
      relay.onSessionData('s1', 'output without titles')
      expect(vi.getTimerCount()).toBe(0)
      expect(emitted).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
