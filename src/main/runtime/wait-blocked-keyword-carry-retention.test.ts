import { describe, expect, it, vi } from 'vitest'
import * as ownership from '../../shared/own-retained-string'
import { OrcaRuntimeWithScheduleWaitBlockedCheck } from './terminal/wait/terminal-wait-blocked-checks'
import { WAIT_BLOCKED_KEYWORD_CARRY_CHARS } from './orca-runtime-postlude'
import type { WaitBlockedCheckState } from './wait-blocked-check-state'

function createScheduleHost() {
  const state = new Map<string, WaitBlockedCheckState>()
  const host = {
    waitBlockedCheckStateByPtyId: state,
    runWaitBlockedCheck: vi.fn<OrcaRuntimeWithScheduleWaitBlockedCheck['runWaitBlockedCheck']>()
  }
  return {
    state,
    schedule(ptyId: string, appendedText: string, at: number) {
      OrcaRuntimeWithScheduleWaitBlockedCheck.prototype['scheduleWaitBlockedCheck'].call(
        host,
        ptyId,
        appendedText,
        at
      )
    }
  }
}

describe('wait-blocked keyword carry storage', () => {
  it('owns the carry so it stops pinning the lowercased chunk window', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const host = createScheduleHost()
      const chunk = `${'Building Project '.repeat(4096)}tail-marker-text`
      host.schedule('pty-1', chunk, 0)

      const carry = host.state.get('pty-1')?.keywordCarry
      expect(carry).toBe(chunk.toLowerCase().slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS))
      expect(carry).toHaveLength(WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
      expect(own).toHaveBeenCalledTimes(1)
      expect(own).toHaveBeenLastCalledWith(carry)
    } finally {
      own.mockRestore()
    }
  })

  it('keeps the carry joined to the next chunk so split keywords still match', () => {
    const host = createScheduleHost()
    host.schedule('pty-2', `${'x'.repeat(8 * 1024)}press`, 0)
    const carry = host.state.get('pty-2')?.keywordCarry
    expect(carry?.endsWith('press')).toBe(true)
    host.schedule('pty-2', ' ENTER to continue', 1)
    expect(host.state.get('pty-2')?.keywordCarry).toBe(
      `${carry} enter to continue`.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
    )
  })
})
