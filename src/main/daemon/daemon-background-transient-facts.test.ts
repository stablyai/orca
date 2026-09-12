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

  it('preserves a provisional 2031 subscribe when scan authority moves to the daemon', () => {
    const { relay, emitted } = createRelay()
    relay.onSessionData('s1', '\x1b[?2031h\x1b[?')
    relay.setSessionBackground('s1', true)
    relay.seedSessionScanState('s1', '\x1b[?')
    relay.onSessionData('s1', '25h')

    expect(emitted).toEqual([{ sessionId: 's1', fact: { kind: '2031-subscribe' } }])
  })

  it('exposes a provisional 2031 subscribe when scan authority returns to main', () => {
    const { relay } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.seedSessionScanState('s1', '')
    relay.onSessionData('s1', '\x1b[?2031h\x1b[?')
    relay.setSessionBackground('s1', false)

    expect(relay.getMode2031ReplyScanState('s1')).toEqual({
      tail: '\x1b[?',
      pendingSubscribe: true
    })
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

describe('BackgroundTransientFactRelay source generations', () => {
  it.each([
    ['old', 'new'],
    ['known', undefined],
    [undefined, 'known']
  ])('does not complete predecessor OSC with a successor BEL (%s → %s)', (old, successor) => {
    const emit = vi.fn()
    const relay = new BackgroundTransientFactRelay(emit)
    relay.setSessionBackground('s', true)
    relay.onSessionData('s', '\x1b]133;D;7', old)
    relay.onSessionData('s', '\x07', successor)
    expect(emit.mock.calls).toEqual([['s', { kind: 'bell' }, successor]])
    relay.onSessionData('s', '\x1b]133;D;', successor)
    relay.onSessionData('s', '0\x07', successor)
    expect(emit.mock.calls.at(-1)).toEqual([
      's',
      { kind: 'command-finished', exitCode: 0 },
      successor
    ])
    relay.dispose()
  })

  it('keeps same-incarnation parser carry over an attach/background handoff, but not a replacement seed', () => {
    const emit = vi.fn()
    const relay = new BackgroundTransientFactRelay(emit)
    relay.onSessionData('s', '\x1b[?2031h\x1b[?', 'old')
    relay.setSessionBackground('s', true)
    relay.seedSessionScanState('s', '\x1b[?', 'old')
    relay.onSessionData('s', '25h', 'old')
    expect(emit.mock.calls).toEqual([['s', { kind: '2031-subscribe' }, 'old']])
    relay.onSessionData('s', '\x1b[?2031h\x1b[?', 'old')
    relay.seedSessionScanState('s', '', 'new')
    expect(relay.getMode2031ReplyScanState('s')).toEqual({ tail: '', pendingSubscribe: false })
    relay.onSessionData('s', '25h', 'new')
    expect(emit).toHaveBeenCalledTimes(1)
    relay.dispose()
  })

  it('keeps an id-less successor source fenced from a delayed predecessor exit', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s', true)
    relay.onSessionData('s', 'predecessor\x07', 'old')
    // The successor attaches without an incarnation id (legacy/unstamped source).
    relay.onSessionData('s', 'successor\x07', undefined)
    emitted.length = 0

    // Delayed exit for the predecessor: the id-less source is still an observed source, so this
    // exit names somebody the session no longer runs and must not dispose the successor's tracker.
    relay.onSessionExit('s', 'old')

    expect(relay.isBackgrounded('s')).toBe(true)
    relay.onSessionData('s', 'successor still here\x07')
    expect(emitted).toEqual([{ sessionId: 's', fact: { kind: 'bell' } }])
    // The session's own untagged exit still retires it: absence is not conflated the other way.
    relay.onSessionExit('s')
    expect(relay.isBackgrounded('s')).toBe(false)
    relay.dispose()
  })

  it('keeps late facts with their observed source and bounds parser lifetime to one source per session', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const relay = new BackgroundTransientFactRelay(emit)
      relay.setSessionBackground('s', true)
      for (let i = 0; i < 200; i++) {
        relay.onSessionData('s', '\x1b]133;D;0\x07\x1b[?', String(i))
      }
      relay.onSessionExit('s', 'old')
      expect(relay.isBackgrounded('s')).toBe(true)
      relay.onSessionData('s', '\x1b]133;D;7\x07', 'old')
      expect(emit.mock.calls.at(-1)).toEqual([
        's',
        { kind: 'command-finished', exitCode: 7 },
        'old'
      ])
      expect(relay['sourceIncarnations'].size).toBe(1)
      expect(relay['trackersBySessionId'].size).toBe(1)
      expect(relay['mode2031ReplyScanStateBySessionId'].size).toBeLessThanOrEqual(1)
      expect(vi.getTimerCount()).toBe(0)
      relay.onSessionExit('s', 'old')
      expect(relay['sourceIncarnations'].size).toBe(0)
      expect(relay['trackersBySessionId'].size).toBe(0)
      expect(relay['mode2031ReplyScanStateBySessionId'].size).toBe(0)
      relay.onSessionData('another', '\x1b[?', 'one')
      relay.dispose()
      expect(relay['sourceIncarnations'].size).toBe(0)
      expect(relay['mode2031ReplyScanStateBySessionId'].size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
