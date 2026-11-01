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
  it('keeps OSC escape state across chunks — a title terminator BEL is not a bell', () => {
    const { relay, emitted } = createRelay()
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', '\x1b]0;my working title')
    relay.onSessionData('s1', ' continued\x07')
    expect(emitted).toEqual([])
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
      // Title-less output after a working title would arm the stale timer if title scanning ran.
      relay.onSessionData('s1', '\x1b]0;⠋ Claude\x07')
      relay.onSessionData('s1', 'output without titles')
      expect(vi.getTimerCount()).toBe(0)
      expect(emitted).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
