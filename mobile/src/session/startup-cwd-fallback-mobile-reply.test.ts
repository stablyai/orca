import { describe, expect, it } from 'vitest'
import {
  activatedAtWorkspaceRoot,
  createdTerminalDesktopWarning
} from './session-write-reply-schema'

describe('optional phone startup-folder result', () => {
  it.each([undefined, null, {}, { startupCwdFallback: true }, { startupCwdFallback: 'future' }])(
    'ignores an absent or unknown extension: %j',
    (raw) => {
      expect(activatedAtWorkspaceRoot(raw)).toBe(false)
    }
  )
  it('keeps the desktop warning sentinel independent from the activation notice', () => {
    const result = { warning: 'desktop-tab-not-shown', startupCwdFallback: 'workspace-root' }
    expect(createdTerminalDesktopWarning(result)).toBe(true)
    expect(activatedAtWorkspaceRoot(result)).toBe(true)
    expect(activatedAtWorkspaceRoot({ warning: 'desktop-tab-not-shown' })).toBe(false)
    expect(createdTerminalDesktopWarning({ startupCwdFallback: 'workspace-root' })).toBe(false)
  })
})
