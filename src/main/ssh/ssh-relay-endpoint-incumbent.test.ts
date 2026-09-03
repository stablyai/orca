import { describe, expect, it, vi } from 'vitest'

const execCommand = vi.fn()
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: (...args: unknown[]) => execCommand(...args),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    (error as { sshChannelCloseConfirmed?: boolean } | null)?.sshChannelCloseConfirmed === false
}))

import {
  describeRelayEndpointIncumbent,
  isReapableRelayHusk,
  mayLaunchOverRelayEndpoint,
  parseRelayEndpointIncumbentProbe,
  probeRelayEndpointIncumbent,
  relayEndpointIncumbentProbeCommand,
  withHandshakeRefusalEvidence,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SOCK = '/home/u/.orca-remote/relay-0.1.0+aaaa/relay-deadbeef.sock'
const POSIX_HOST = getRemoteHostPlatform('linux-x64')
const WINDOWS_HOST = getRemoteHostPlatform('win32-x64')

function probeOutput(lines: string[]): string {
  return ['ORCA-INCUMBENT-BEGIN', ...lines, 'ORCA-INCUMBENT-END'].join('\n')
}

describe('parseRelayEndpointIncumbentProbe', () => {
  it('reports live when the socket accepted a connection', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=4242 yes 13'])
    )
    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('accepted-connection')
    expect(incumbent.holders).toEqual([{ pid: 4242, matchesRelayArgv: true, childCount: 13 }])
  })

  it('reports live when a process still holds an inode that refuses connections', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof', 'HOLDER=91 yes 2'])
    )
    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('holder-process')
  })

  it('reports exited only when the connect was refused AND nothing holds the socket', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof'])
    )
    expect(incumbent.verdict).toBe('exited')
    expect(incumbent.evidence).toBe('no-holder')
    expect(incumbent.socketPresent).toBe(true)
  })

  it('reports unverifiable when the host cannot enumerate socket holders', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=unavailable'])
    )
    expect(incumbent.verdict).toBe('unverifiable')
    expect(incumbent.holdersEnumerable).toBe(false)
  })

  it('reports unverifiable when the connect probe timed out', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=lsof'])
    )
    expect(incumbent.verdict).toBe('unverifiable')
  })

  it('reports unverifiable for truncated or garbled probe output', () => {
    expect(parseRelayEndpointIncumbentProbe(SOCK, 'PRESENT=yes\nLISTEN=refused').verdict).toBe(
      'unverifiable'
    )
    expect(parseRelayEndpointIncumbentProbe(SOCK, '').verdict).toBe('unverifiable')
  })

  it('drops holder lines that do not carry a usable pid', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof', 'HOLDER=- no unknown'])
    )
    expect(incumbent.holders).toEqual([])
    expect(incumbent.verdict).toBe('exited')
  })

  it('keeps an unreadable child count as null rather than zero', () => {
    const [holder] = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=7 yes unknown'])
    ).holders
    expect(holder.childCount).toBeNull()
  })
})

describe('probeRelayEndpointIncumbent', () => {
  it('never asserts death when the probe itself could not run', async () => {
    execCommand.mockRejectedValueOnce(new Error('channel closed'))
    const incumbent = await probeRelayEndpointIncumbent(
      {} as SshConnection,
      POSIX_HOST,
      '/usr/bin/node',
      SOCK
    )
    expect(incumbent.verdict).toBe('unverifiable')
    expect(incumbent.holders).toEqual([])
  })

  it('does not shell out on Windows hosts, where the endpoint is a named pipe', async () => {
    execCommand.mockClear()
    const incumbent = await probeRelayEndpointIncumbent(
      {} as SshConnection,
      WINDOWS_HOST,
      'node.exe',
      SOCK
    )
    expect(execCommand).not.toHaveBeenCalled()
    expect(incumbent.verdict).toBe('unverifiable')
  })
})

describe('relayEndpointIncumbentProbeCommand', () => {
  it('ANDs the lsof selectors so it cannot match unrelated unix-socket holders', () => {
    expect(relayEndpointIncumbentProbeCommand('/usr/bin/node', SOCK)).toContain(
      'lsof -t -a -U "$sock"'
    )
  })

  it('never mutates the host: no unlink, no signal', () => {
    const command = relayEndpointIncumbentProbeCommand('/usr/bin/node', SOCK)
    expect(command).not.toMatch(/\brm\b/)
    expect(command).not.toMatch(/\bkill\b/)
  })
})

describe('withHandshakeRefusalEvidence', () => {
  it('upgrades an unenumerable endpoint to live when the daemon answered the handshake', () => {
    const probed = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=unavailable'])
    )
    const incumbent = withHandshakeRefusalEvidence(probed)
    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('handshake-refusal')
    expect(mayLaunchOverRelayEndpoint(incumbent)).toBe(false)
  })

  it('leaves stronger evidence in place', () => {
    const probed = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof'])
    )
    expect(withHandshakeRefusalEvidence(probed).evidence).toBe('accepted-connection')
  })
})

describe('mayLaunchOverRelayEndpoint', () => {
  const verdicts: RelayEndpointIncumbent['verdict'][] = ['live', 'unverifiable', 'exited']
  it.each(verdicts)('permits a relaunch for %s only when it is not live', (verdict) => {
    const incumbent = { ...parseRelayEndpointIncumbentProbe(SOCK, ''), verdict }
    expect(mayLaunchOverRelayEndpoint(incumbent)).toBe(verdict !== 'live')
  })
})

describe('isReapableRelayHusk', () => {
  const husk = parseRelayEndpointIncumbentProbe(
    SOCK,
    probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=500 yes 0'])
  )

  it('accepts a single proven relay holder with zero children', () => {
    expect(isReapableRelayHusk(husk)).toBe(true)
  })

  it('refuses a relay that still holds children', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: true, childCount: 1 }]
      })
    ).toBe(false)
  })

  it('refuses a holder whose child count could not be read', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: true, childCount: null }]
      })
    ).toBe(false)
  })

  it('refuses a holder whose argv is not this relay at this socket', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: false, childCount: 0 }]
      })
    ).toBe(false)
  })

  it('refuses when more than one process holds the socket', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [
          { pid: 500, matchesRelayArgv: true, childCount: 0 },
          { pid: 501, matchesRelayArgv: true, childCount: 0 }
        ]
      })
    ).toBe(false)
  })

  it('refuses an unverifiable endpoint however empty it looks', () => {
    expect(isReapableRelayHusk({ ...husk, verdict: 'unverifiable' })).toBe(false)
    expect(isReapableRelayHusk({ ...husk, holdersEnumerable: false })).toBe(false)
  })
})

describe('describeRelayEndpointIncumbent', () => {
  it('distinguishes "no holders" from "could not enumerate holders"', () => {
    const none = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof'])
    )
    const unknown = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=unavailable'])
    )
    expect(describeRelayEndpointIncumbent(none)).toContain('holders=none')
    expect(describeRelayEndpointIncumbent(unknown)).toContain('holders=unenumerable')
  })
})
