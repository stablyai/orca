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

const marker = (payload: string, terminator: string): string => `\x1b]133;${payload}${terminator}`

describe('OSC 133 continuity across background handoffs', () => {
  it.each(['\x07', '\x1b\\'])('keeps app zones across every split with terminator %j', (end) => {
    const zone = marker('B', end) + marker('C', end) + marker('D;0', end)
    for (let split = 0; split <= zone.length; split += 1) {
      const { relay, emitted } = createRelay()
      relay.onSessionData('s1', zone.slice(0, split))
      relay.setSessionBackground('s1', true)
      // The emulator may seed a partial escape already consumed by the shadow scanner.
      relay.seedSessionScanState('s1', relay.getOsc133ScanState('s1').carry)
      for (const byte of zone.slice(split)) {
        relay.onSessionData('s1', byte)
      }
      expect(emitted, `split ${split}`).toEqual([])
      relay.dispose()
    }
  })

  it.each([
    ['C', 'D;0', 0],
    ['B', 'C', 'D;1', 1],
    ['B', 'typed command', 'C', 'D;0', 0]
  ])('preserves real command completion through handoffs: %j', (...parts) => {
    const exitCode = parts.at(-1)
    const chunks = parts
      .slice(0, -1)
      .map((part) => (part === 'typed command' ? part : marker(String(part), '\x07')))
    const { relay, emitted } = createRelay()
    relay.onSessionData('s1', chunks[0])
    relay.setSessionBackground('s1', true)
    for (const chunk of chunks.slice(1)) {
      relay.onSessionData('s1', chunk)
    }
    expect(emitted).toEqual([{ sessionId: 's1', fact: { kind: 'command-finished', exitCode } }])
    relay.dispose()
  })

  it('retains only current adjacency through repeated toggles without replaying completion', () => {
    const { relay, emitted } = createRelay()
    relay.onSessionData('s1', marker('B', '\x07'))
    relay.setSessionBackground('s1', true)
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', marker('C', '\x07'))
    relay.setSessionBackground('s1', false)
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', marker('D;0', '\x07'))
    expect(emitted).toEqual([])
    relay.onSessionData('s1', marker('D;0', '\x07'))
    expect(emitted).toEqual([{ sessionId: 's1', fact: { kind: 'command-finished', exitCode: 0 } }])
    relay.setSessionBackground('s1', false)
    relay.setSessionBackground('s1', true)
    expect(emitted).toHaveLength(1)
    relay.dispose()
  })

  it('forgets adjacency on session exit and ordinary output', () => {
    const { relay, emitted } = createRelay()
    const bc = marker('B', '\x07') + marker('C', '\x07')
    relay.onSessionData('s1', bc)
    relay.onSessionExit('s1')
    relay.setSessionBackground('s1', true)
    relay.onSessionData('s1', marker('D;0', '\x07'))
    relay.onSessionData('s1', `${bc}output${marker('D;0', '\x07')}`)
    expect(emitted).toEqual([
      { sessionId: 's1', fact: { kind: 'command-finished', exitCode: 0 } },
      { sessionId: 's1', fact: { kind: 'command-finished', exitCode: 0 } }
    ])
    relay.dispose()
  })
})
