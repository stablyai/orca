import { describe, expect, it } from 'vitest'
import {
  createShellStartupIdentityScanState,
  drainShellStartupIdentityHeldBytes,
  scanForShellStartupIdentity
} from './shell-startup-identity-scanner'

describe('shell startup identity scanner', () => {
  it('strips a split identity marker and returns its shell pid', () => {
    const state = createShellStartupIdentityScanState()
    expect(scanForShellStartupIdentity(state, 'before\x1b]777;orca-shell-st')).toEqual({
      output: 'before',
      shellPid: null
    })
    expect(scanForShellStartupIdentity(state, 'art:12345\x07after')).toEqual({
      output: 'after',
      shellPid: 12345
    })
  })

  it('strips a v2 marker and returns start time plus decoded tty', () => {
    const state = createShellStartupIdentityScanState()
    const tty = Buffer.from('/dev/ttys048').toString('base64')
    expect(
      scanForShellStartupIdentity(
        state,
        `before\x1b]777;orca-shell-start;v2;12345;987654;${tty}\x07after`
      )
    ).toEqual({
      output: 'beforeafter',
      shellPid: 12345,
      shellStartTime: '987654',
      tty: '/dev/ttys048'
    })
  })

  it('forwards malformed v2 markers unchanged', () => {
    const state = createShellStartupIdentityScanState()
    const input = '\x1b]777;orca-shell-start;v2;123;bad;%%%\x07'
    expect(scanForShellStartupIdentity(state, input)).toEqual({ output: input, shellPid: null })
  })

  it('forwards lookalikes unchanged', () => {
    const state = createShellStartupIdentityScanState()
    const input = 'a\x1b]777;orca-shell-start:nope\x07b'
    expect(scanForShellStartupIdentity(state, input)).toEqual({ output: input, shellPid: null })
  })

  it('forwards an unrelated OSC ending in digits', () => {
    const state = createShellStartupIdentityScanState()
    const input = '\x1b]1337;remote-session:12345'
    expect(scanForShellStartupIdentity(state, input)).toEqual({ output: input, shellPid: null })
    expect(state.heldBytes).toBe('')
  })

  it('releases an incomplete marker on teardown', () => {
    const state = createShellStartupIdentityScanState()
    scanForShellStartupIdentity(state, '\x1b]777;orca-shell-start:12')
    expect(drainShellStartupIdentityHeldBytes(state)).toBe('\x1b]777;orca-shell-start:12')
  })

  it('does not retain an unbounded digit stream', () => {
    const state = createShellStartupIdentityScanState()
    const input = `\x1b]777;orca-shell-start:${'1'.repeat(100)}`
    expect(scanForShellStartupIdentity(state, input).output).toBe(input)
    expect(state.heldBytes).toBe('')
  })
})
