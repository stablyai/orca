import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalInputGate } from './terminal-input-connection-gate'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'

describe('terminal input connection gate', () => {
  it('Given a live connection on a terminal tab Then composing and sending are both allowed', () => {
    expect(
      resolveMobileTerminalInputGate({
        connState: 'connected',
        activeHandle: 'terminal-a',
        activeSessionTabType: 'terminal'
      })
    ).toEqual({ canCompose: true, canSend: true })
  })

  it('Given a cut connection Then composing stays available while sending is blocked', () => {
    for (const connState of [
      'connecting',
      'handshaking',
      'disconnected',
      'reconnecting',
      'auth-failed'
    ] as const) {
      expect(
        resolveMobileTerminalInputGate({
          connState,
          activeHandle: 'terminal-a',
          activeSessionTabType: 'terminal'
        })
      ).toEqual({ canCompose: true, canSend: false })
    }
  })

  it('Given a non-terminal tab or no handle Then neither composing nor sending is allowed', () => {
    for (const activeSessionTabType of ['markdown', 'file', 'browser']) {
      expect(
        resolveMobileTerminalInputGate({
          connState: 'connected',
          activeHandle: 'terminal-a',
          activeSessionTabType
        })
      ).toEqual({ canCompose: false, canSend: false })
    }
    expect(
      resolveMobileTerminalInputGate({
        connState: 'connected',
        activeHandle: null,
        activeSessionTabType: 'terminal'
      })
    ).toEqual({ canCompose: false, canSend: false })
  })

  it('Given a lagging tab list yielding no tab Then the gate treats the type as unknown, not non-terminal', () => {
    expect(
      resolveMobileTerminalInputGate({
        connState: 'disconnected',
        activeHandle: 'terminal-a',
        activeSessionTabType: undefined
      })
    ).toEqual({ canCompose: true, canSend: false })
  })
})

describe('terminal send request shape', () => {
  it('keeps every keystroke-grade terminal send now-or-never so nothing replays after reconnect', () => {
    // A parked send replays stale bytes into the PTY once the socket comes back.
    expect(TERMINAL_INPUT_SEND_OPTIONS).toEqual({ failWhenDisconnected: true })
  })

  it('tags terminal sends with the device presence lock only when a token exists', () => {
    expect(
      buildTerminalSendParams({ terminal: 't1', text: 'ls', enter: true, deviceToken: 'tok' })
    ).toEqual({ terminal: 't1', text: 'ls', enter: true, client: { id: 'tok', type: 'mobile' } })
    expect(
      buildTerminalSendParams({ terminal: 't1', text: 'ls', enter: false, deviceToken: null })
    ).toEqual({ terminal: 't1', text: 'ls', enter: false })
  })
})
