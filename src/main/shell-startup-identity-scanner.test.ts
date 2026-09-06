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

  it('parses a fenced WSL identity anchor', () => {
    const state = createShellStartupIdentityScanState()
    const result = scanForShellStartupIdentity(
      state,
      'x\x1b]777;orca-shell-start:v2:Ubuntu-24.04:01234567-89ab-cdef-0123-456789abcdef:123:456:/dev/pts/8\x07y'
    )
    expect(result).toEqual({
      output: 'xy',
      shellPid: 123,
      shellIdentity: {
        distro: 'Ubuntu-24.04',
        bootId: '01234567-89ab-cdef-0123-456789abcdef',
        shellPid: 123,
        shellStartTime: 456,
        tty: '/dev/pts/8'
      }
    })
  })

  it('holds a split v2 anchor until the BEL terminator', () => {
    const state = createShellStartupIdentityScanState()
    const first =
      '\x1b]777;orca-shell-start:v2:Ubuntu:01234567-89ab-cdef-0123-456789abcdef:12:34:/dev/pts/'
    expect(scanForShellStartupIdentity(state, first)).toEqual({ output: '', shellPid: null })
    expect(scanForShellStartupIdentity(state, '2\x07ok')).toMatchObject({
      output: 'ok',
      shellPid: 12,
      shellIdentity: { distro: 'Ubuntu', shellStartTime: 34, tty: '/dev/pts/2' }
    })
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
