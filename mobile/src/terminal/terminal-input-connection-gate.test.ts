import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalInputGate } from './terminal-input-connection-gate'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

function routeSlice(anchorStart: string, anchorEnd: string): string {
  const start = sessionRouteSource.indexOf(anchorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  // Why: a duplicated start anchor would silently slice the wrong region.
  expect(sessionRouteSource.indexOf(anchorStart, start + 1)).toBe(-1)
  const end = sessionRouteSource.indexOf(anchorEnd, start)
  expect(end).toBeGreaterThan(start)
  return sessionRouteSource.slice(start, end + anchorEnd.length)
}

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

describe('session route offline-compose wiring', () => {
  it('derives both gates from the shared resolver', () => {
    expect(sessionRouteSource).toContain('resolveMobileTerminalInputGate({')
  })

  it('keeps the buffered command box editable offline while the live capture stays send-gated', () => {
    const bufferedInput = routeSlice(
      'ref={commandInputRef}',
      'onSubmitEditing={() => void handleSend()}'
    )
    expect(bufferedInput).toContain('editable={canCompose}')

    const liveCapture = routeSlice('ref={liveInputRef}', 'importantForAutofill="no"')
    expect(liveCapture).toContain('editable={canSend}')
  })

  it('keeps the send button connection-gated so held text cannot fire into a dead link', () => {
    const sendButton = routeSlice('styles.sendButton,', 'accessibilityLabel="Send command"')
    expect(sendButton).toContain('disabled={!canSend}')
  })

  it('holds composed text when the return key submits offline', () => {
    const handleSend = routeSlice('async function handleSend()', 'sendingRef.current = true')
    expect(handleSend).toContain('!canSend')
  })

  it('keeps the live/buffered mode toggle reachable offline', () => {
    const modeToggle = routeSlice(
      'liveInputEnabled && styles.accessoryKeyActive',
      'onPress={toggleLiveInput}'
    )
    expect(modeToggle).toContain('disabled={!canCompose}')
  })

  it('tells the live-input commit hook about connection loss so stale mirror state resets', () => {
    const hookCall = routeSlice('useTerminalLiveInputCommit({', 'setLiveInputCapture')
    expect(hookCall).toContain("connected: connState === 'connected'")
  })

  it('keeps every keystroke-grade terminal send now-or-never so nothing replays after reconnect', () => {
    // Live mirror, buffered send, and gesture arrows must all opt out of the
    // connect wait — a parked send replays stale bytes into the PTY. Accessory
    // keys get the same option inside terminal-live-accessory-raw-send.ts.
    const optOuts = sessionRouteSource.match(/TERMINAL_INPUT_SEND_OPTIONS/g)?.length ?? 0
    expect(optOuts).toBe(4)
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
