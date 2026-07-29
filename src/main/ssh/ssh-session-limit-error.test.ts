import { describe, expect, it } from 'vitest'
import { isSshSessionLimitError } from './ssh-session-limit-error'

describe('isSshSessionLimitError', () => {
  it('matches ssh2 open failures with the resource-shortage reason code', () => {
    expect(
      isSshSessionLimitError(
        Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 4 })
      )
    ).toBe(true)
  })

  it('matches the OpenSSH MaxSessions rejection (SSH2_OPEN_CONNECT_FAILED + "open failed")', () => {
    // Why: stock OpenSSH sshd refuses session channels over MaxSessions with
    // reason 2, not resource-shortage — observed against OpenSSH 9.2.
    expect(
      isSshSessionLimitError(
        Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 })
      )
    ).toBe(true)
  })

  it('matches OpenSSH mux and MaxSessions failures', () => {
    expect(
      isSshSessionLimitError(
        new Error(
          'mux_client_request_session: session request failed: Session open refused by peer'
        )
      )
    ).toBe(true)
    expect(
      isSshSessionLimitError(new Error('open failed: MaxSessions limit reached on remote host'))
    ).toBe(true)
  })

  it('does not match generic channel-open failures without a session-limit reason', () => {
    expect(
      isSshSessionLimitError(
        Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 1 })
      )
    ).toBe(false)
    expect(
      isSshSessionLimitError(
        Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 3 })
      )
    ).toBe(false)
  })

  it('does not match unrelated command failures', () => {
    expect(
      isSshSessionLimitError(new Error('Command "node" failed (exit 1): Node.js not found'))
    ).toBe(false)
    expect(isSshSessionLimitError(new Error('channel open failure while parsing output'))).toBe(
      false
    )
    expect(
      isSshSessionLimitError(
        new Error('open failed: administratively prohibited: forwarding disabled')
      )
    ).toBe(false)
  })
})
