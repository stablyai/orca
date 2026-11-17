import { describe, expect, it } from 'vitest'
import { sleepingLeafPtyToReplace } from './sleeping-leaf-resume'

describe('explicit resume into a Restart-stopped pane', () => {
  it('replaces the leaf whose PTY was stopped, so the resume argv runs there', () => {
    expect(sleepingLeafPtyToReplace({ ptyId: 'pty-1', connected: false })).toBe('pty-1')
  })

  it('still adopts a live pane, and has nothing to replace without a PTY', () => {
    expect(sleepingLeafPtyToReplace({ ptyId: 'pty-1', connected: true })).toBeUndefined()
    expect(sleepingLeafPtyToReplace({ ptyId: null, connected: false })).toBeUndefined()
    expect(sleepingLeafPtyToReplace(undefined)).toBeUndefined()
  })
})
