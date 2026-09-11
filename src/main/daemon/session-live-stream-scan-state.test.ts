import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import { getTerminalHostStreamScanState } from './terminal-host-session-inspection-operations'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { MAX_PARTIAL_ESCAPE_TAIL_LENGTH } from '../../shared/terminal-partial-escape-tail'
import { SessionOutputPlane } from './session-output-plane'

const sessions: Session[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose()
  }
})

function createSession(historySeedChunks?: string[]) {
  const subprocess = createMockSubprocess()
  const session = new Session({
    sessionId: 'same-id',
    cols: 80,
    rows: 24,
    subprocess,
    shellReadySupported: false,
    historySeedChunks
  })
  sessions.push(session)
  return { session, subprocess }
}

describe('Session live stream scan state', () => {
  it('never promotes a history-seeded dangling OSC into current-incarnation evidence', () => {
    const history = '\x1b]133;D;7'
    const { session, subprocess } = createSession([history])
    const emit = vi.fn()
    const relay = new BackgroundTransientFactRelay(emit)
    relay.setSessionBackground(session.sessionId, true)
    const seed = getTerminalHostStreamScanState(session)
    expect(session.historySeeded).toBe(true)
    expect(seed).toEqual({ partialEscapeTailAnsi: '', incarnationId: session.incarnationId })
    relay.seedSessionScanState(session.sessionId, seed.partialEscapeTailAnsi, seed.incarnationId)
    session.attachClient({
      onData: (data, _rawLength, _transformed, _seq, source) =>
        relay.onSessionData(session.sessionId, data, source),
      onExit: () => {}
    })
    subprocess._simulateData('\x07')
    expect(emit.mock.calls).toEqual([[session.sessionId, { kind: 'bell' }, session.incarnationId]])
    expect(emit.mock.calls.some(([, fact]) => fact.kind === 'command-finished')).toBe(false)
    relay.dispose()
  })

  it('preserves a live split OSC handoff even when the emulator was initialized from history', () => {
    const { session, subprocess } = createSession(['\x1b]0;predecessor title'])
    subprocess._simulateData('\x1b]133;D;')
    const seed = getTerminalHostStreamScanState(session)
    expect(seed).toEqual({
      partialEscapeTailAnsi: '\x1b]133;D;',
      incarnationId: session.incarnationId
    })
    const emit = vi.fn()
    const relay = new BackgroundTransientFactRelay(emit)
    relay.setSessionBackground(session.sessionId, true)
    relay.seedSessionScanState(session.sessionId, seed.partialEscapeTailAnsi, seed.incarnationId)
    session.attachClient({
      onData: (data, _rawLength, _transformed, _seq, source) =>
        relay.onSessionData(session.sessionId, data, source),
      onExit: () => {}
    })
    subprocess._simulateData('0\x07')
    expect(emit.mock.calls).toEqual([
      [session.sessionId, { kind: 'command-finished', exitCode: 0 }, session.incarnationId]
    ])
    expect(getTerminalHostStreamScanState(session).partialEscapeTailAnsi).toBe('')
    relay.dispose()
  })

  it('bounds the live tail independently of history and clears it on disposal/replacement', () => {
    const { session, subprocess } = createSession()
    subprocess._simulateData('\x1b]0;')
    for (let i = 0; i < 10; i++) {
      subprocess._simulateData('x'.repeat(1024))
      expect(session.getLivePartialEscapeTailAnsi().length).toBeLessThanOrEqual(
        MAX_PARTIAL_ESCAPE_TAIL_LENGTH
      )
    }
    subprocess._simulateData('\x1b]133;D;')
    expect(session.getLivePartialEscapeTailAnsi()).toBe('\x1b]133;D;')
    session.dispose()
    expect(session.getLivePartialEscapeTailAnsi()).toBe('')
    const replacement = createSession().session
    expect(replacement.incarnationId).not.toBe(session.incarnationId)
    expect(replacement.getLivePartialEscapeTailAnsi()).toBe('')
  })

  it('tracks only post-filter delivery, including a held escape released by the DA filter', () => {
    const output = new SessionOutputPlane({
      cols: 80,
      rows: 24,
      historySeedChunks: ['\x1b]0;history']
    })
    try {
      output.installDeviceAttributesFilter()
      output.emit({ data: '\x1b[', rawStartSeq: 0, rawEndSeq: 2, transformed: false })
      expect(output.getLivePartialEscapeTailAnsi()).toBe('')
      output.releaseDeviceAttributesFilter()
      expect(output.getLivePartialEscapeTailAnsi()).toBe('\x1b[')
      expect(output.getSnapshot()?.outputSequence).toBe(2)
      output.markDisposed()
      expect(output.getLivePartialEscapeTailAnsi()).toBe('')
    } finally {
      output.disposeEmulator()
    }
  })
})
