import { describe, expect, it } from 'vitest'
import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'

describe('terminal live accessory raw send target', () => {
  it('Given the original terminal is still active When raw fallback resumes Then returns that handle', () => {
    // Given
    const targetHandle = 'terminal-a'

    // When
    const sendTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'terminal',
      liveInputTerminalHandles: new Set([targetHandle])
    })

    // Then
    expect(sendTarget).toBe(targetHandle)
  })

  it('Given the active terminal changed while waiting When raw fallback resumes Then suppresses the send', () => {
    // Given
    const targetHandle = 'terminal-a'

    // When
    const sendTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: 'terminal-b',
      activeSessionTabType: 'terminal',
      liveInputTerminalHandles: new Set([targetHandle, 'terminal-b'])
    })

    // Then
    expect(sendTarget).toBeNull()
  })

  it('Given the target is not a live active terminal When raw fallback resumes Then suppresses the send', () => {
    // Given
    const targetHandle = 'terminal-a'

    // When
    const inactiveTabTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'browser',
      liveInputTerminalHandles: new Set([targetHandle])
    })
    const detachedTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'terminal',
      liveInputTerminalHandles: new Set()
    })

    // Then
    expect(inactiveTabTarget).toBeNull()
    expect(detachedTarget).toBeNull()
  })
})
