import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

const CLOSED = 'Remote Orca runtime closed the connection (4001: Unauthorized).'
const tunnel = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  localPort: 52_011,
  remotePort: 6_770
}

describe('withRuntimeUnreachableHint', () => {
  it('never offers Tailscale for a server reached through an SSH tunnel (#37766)', () => {
    expect(
      withRuntimeUnreachableHint({ orcadDeployment: tunnel }, CLOSED, 'ws://127.0.0.1:52011')
    ).toBe(CLOSED)
    expect(
      withRuntimeUnreachableHint(
        {
          sshAccess: {
            ...tunnel,
            endpointId: 'tunnel',
            previousPreferredEndpointId: 'lan'
          }
        },
        CLOSED,
        'ws://127.0.0.1:52011'
      )
    ).toBe(CLOSED)
  })

  it('still offers Tailscale for a directly paired server', () => {
    expect(withRuntimeUnreachableHint({}, CLOSED, 'ws://192.168.1.10:6768')).toContain(
      'connect both devices to Tailscale'
    )
  })
})
