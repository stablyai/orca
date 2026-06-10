import { afterEach, describe, expect, it } from 'vitest'
import {
  beginClaudeAuthSwitch,
  endClaudeAuthSwitch,
  isClaudeAuthSwitchInProgress,
  markClaudePtyExited,
  markClaudePtySpawned
} from './live-pty-gate'

describe('Claude live PTY gate', () => {
  afterEach(() => {
    markClaudePtyExited('live-claude-pty')
    endClaudeAuthSwitch()
  })

  it('allows switching while Claude PTYs are live', () => {
    markClaudePtySpawned('live-claude-pty')

    beginClaudeAuthSwitch()

    expect(isClaudeAuthSwitchInProgress()).toBe(true)
  })

  it('still rejects overlapping account switches', () => {
    beginClaudeAuthSwitch()

    expect(() => beginClaudeAuthSwitch()).toThrow('already in progress')
  })
})
