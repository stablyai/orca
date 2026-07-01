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
      activeSessionTabType: 'terminal'
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
      activeSessionTabType: 'terminal'
    })

    // Then
    expect(sendTarget).toBeNull()
  })

  it('Given the target is not an active terminal tab When raw fallback resumes Then suppresses the send', () => {
    // Given
    const targetHandle = 'terminal-a'

    // When
    const inactiveTabTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'browser'
    })

    // Then
    expect(inactiveTabTarget).toBeNull()
  })
})
