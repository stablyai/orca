import { describe, expect, it } from 'vitest'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'

describe('shouldActivateOpenedMobileSessionTab', () => {
  const currentTerminalState = {
    activationSeq: 2,
    latestActivationSeq: 2,
    sourceTerminalHandle: 'pty-1',
    activeTerminalHandle: 'pty-1',
    activeTabType: 'terminal'
  }

  it('allows the latest tap while the source terminal is still active', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false
      })
    ).toBe(true)
  })

  it('stops later retries after the first successful activation', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: true
      })
    ).toBe(false)
  })

  it('prevents an older tap from stealing focus from a newer tap', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        activationSeq: 1
      })
    ).toBe(false)
  })

  it('does not activate after the user leaves the source terminal', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        activeTabType: 'file',
        activeTerminalHandle: null
      })
    ).toBe(false)
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        activeTerminalHandle: 'pty-2'
      })
    ).toBe(false)
  })

  it('allows a structured agent-session tab to anchor chat file activation', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        activated: false,
        activationSeq: 2,
        latestActivationSeq: 2,
        sourceTerminalHandle: null,
        activeTerminalHandle: null,
        sourceSessionTabId: 'agent-tab-1',
        activeSessionTabId: 'agent-tab-1',
        activeTabType: 'agent-session'
      })
    ).toBe(true)
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        sourceTerminalHandle: null,
        activeTerminalHandle: null,
        sourceSessionTabId: 'agent-tab-1',
        activeSessionTabId: 'agent-tab-2',
        activeTabType: 'agent-session'
      })
    ).toBe(false)
  })
})
