import { describe, expect, it } from 'vitest'
import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'

describe('terminal live accessory raw send target', () => {
  it('Given the original terminal is still active When raw fallback resumes Then returns that handle', () => {
    const targetHandle = 'terminal-a'

    const sendTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'terminal'
    })

    expect(sendTarget).toBe(targetHandle)
  })

  it('Given the active terminal changed while waiting When raw fallback resumes Then suppresses the send', () => {
    const targetHandle = 'terminal-a'

    const sendTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: 'terminal-b',
      activeSessionTabType: 'terminal'
    })

    expect(sendTarget).toBeNull()
  })

  it('Given the target is not an active terminal tab When raw fallback resumes Then suppresses the send', () => {
    const targetHandle = 'terminal-a'

    const inactiveTabTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: targetHandle,
      activeSessionTabType: 'browser'
    })

    expect(inactiveTabTarget).toBeNull()
  })
})
