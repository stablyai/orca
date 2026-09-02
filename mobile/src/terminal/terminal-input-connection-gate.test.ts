import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalInputGate } from './terminal-input-connection-gate'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { readMobileSessionRouteSource } from '../session/mobile-session-route-source-family.test-support'

const runtimeSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-terminal-runtime.ts'
)
const sendActionsSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-terminal-send-actions.ts'
)
const terminalInputSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-terminal-input.ts'
)
const commandDockSource = readMobileSessionRouteSource('../session/MobileSessionCommandDock.tsx')

function sourceSlice(source: string, anchorStart: string, anchorEnd: string): string {
  const start = source.indexOf(anchorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  // Why: a duplicated start anchor would silently slice the wrong region.
  expect(source.indexOf(anchorStart, start + 1)).toBe(-1)
  const end = source.indexOf(anchorEnd, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + anchorEnd.length)
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
    expect(runtimeSource).toContain('resolveMobileTerminalInputGate({')
  })

  it('keeps the buffered command box editable offline while the live capture stays send-gated', () => {
    const bufferedInput = sourceSlice(
      commandDockSource,
      'ref={commandInputRef}',
      'onSubmitEditing={() => void handleSend()}'
    )
    expect(bufferedInput).toContain('editable={canCompose}')

    const liveCapture = sourceSlice(
      commandDockSource,
      'ref={liveInputRef}',
      'importantForAutofill="no"'
    )
    expect(liveCapture).toContain('editable={canSend}')
  })

  it('keeps the send button connection-gated so held text cannot fire into a dead link', () => {
    const sendButton = sourceSlice(
      commandDockSource,
      'styles.sendButton,',
      'accessibilityLabel="Send command"'
    )
    expect(sendButton).toContain('disabled={!canSend}')
  })

  it('holds composed text when the return key submits offline', () => {
    const handleSend = sourceSlice(
      sendActionsSource,
      'async function handleSend()',
      'sendingRef.current = true'
    )
    expect(handleSend).toContain('!canSend')
  })

  it('keeps the live/buffered mode toggle reachable offline', () => {
    const modeToggle = sourceSlice(
      commandDockSource,
      'liveInputEnabled && styles.accessoryKeyActive',
      'onPress={toggleLiveInput}'
    )
    expect(modeToggle).toContain('disabled={!canCompose}')
  })

  it('tells the live-input commit hook about connection loss so stale mirror state resets', () => {
    const hookCall = sourceSlice(
      runtimeSource,
      'useTerminalLiveInputCommit({',
      'setLiveInputCapture'
    )
    expect(hookCall).toContain("connected: connState === 'connected'")
  })

  it('keeps every keystroke-grade terminal send now-or-never so nothing replays after reconnect', () => {
    // Live mirror, buffered send, and gesture arrows must all opt out of the
    // connect wait — a parked send replays stale bytes into the PTY. Accessory
    // keys get the same option inside terminal-live-accessory-raw-send.ts.
    expect(sendActionsSource).toContain('TERMINAL_INPUT_SEND_OPTIONS')
    expect(terminalInputSource).toContain('TERMINAL_INPUT_SEND_OPTIONS')
    const optionUses = [sendActionsSource, terminalInputSource].flatMap(
      (source) => source.match(/TERMINAL_INPUT_SEND_OPTIONS/g) ?? []
    ).length
    // Two owner imports plus one buffered, one live, and one gesture send.
    expect(optionUses).toBe(5)
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
