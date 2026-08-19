import { describe, expect, it } from 'vitest'

import { terminateRelaySocketHolderScript } from './ssh-relay-socket-termination'

function script(sockExpr = '"$sock"', pgrepExpr = '"$sock_name"'): string {
  return terminateRelaySocketHolderScript(sockExpr, pgrepExpr).join('\n')
}

describe('terminateRelaySocketHolderScript', () => {
  it('kills the socket holder before unlinking the socket', () => {
    const generated = script()

    // Why (#8585): the socket path is the only handle on a detached relay — unlink
    // first and the daemon plus its PTYs leak with nothing able to find them again.
    expect(generated.indexOf('kill -TERM')).toBeLessThan(generated.indexOf('rm -f'))
    expect(generated).toContain('kill -KILL $pid')
  })

  it('scopes lsof to the one relay socket', () => {
    // Why (#8762): lsof ORs its selectors, so -a is what keeps this off unrelated holders.
    expect(script()).toContain('lsof -t -a -U "$sock"')
  })

  it('accepts a literal socket path and a separate pgrep pattern', () => {
    const generated = script(
      "'/home/u/.orca-remote/relay-0.1.0+abc/relay-1234.sock'",
      "'relay-1234.sock'"
    )

    expect(generated).toContain(
      "if [ -S '/home/u/.orca-remote/relay-0.1.0+abc/relay-1234.sock' ]; then"
    )
    expect(generated).toContain("rm -f '/home/u/.orca-remote/relay-0.1.0+abc/relay-1234.sock'")
    // Why: `pgrep -f` takes an ERE, so the versioned path's `+` would read as a quantifier.
    expect(generated).toContain("pgrep -f 'relay-1234.sock'")
  })

  it('skips a path that is not a socket', () => {
    expect(script()).toContain('if [ -S "$sock" ]; then')
  })
})
