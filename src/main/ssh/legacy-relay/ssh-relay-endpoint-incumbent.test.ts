import type * as ExecCommandModule from '../remote-exec/remote-exec-command'
import { describe, expect, it, vi } from 'vitest'
import { RELAY_LSOF_PROBE_JS } from '@orca/process-host/posix-lsof-probe'

const execCommand = vi.fn()
vi.mock('../remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: (...args: unknown[]) => execCommand(...args),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    (error as { sshChannelCloseConfirmed?: boolean } | null)?.sshChannelCloseConfirmed === false
}))

import {
  isReapableRelayHusk,
  parseRelayEndpointIncumbentProbe,
  probeRelayEndpointIncumbent,
  relayEndpointIncumbentProbeCommand
} from './ssh-relay-endpoint-incumbent'
import { getRemoteHostPlatform } from '../ssh-remote-platform'
import { unusedSshConnection } from '../unused-host-transport.test-fixture'

const connection = unusedSshConnection()

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
      probeOutput([
        'PRESENT=yes',
        'LISTEN=accepted',
        'HOLDERS_SOURCE=lsof',
        'HOLDER=4242 yes 13 11'
      ])
    )
    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('accepted-connection')
    expect(incumbent.holders).toEqual([
      { pid: 4242, matchesRelayArgv: true, childCount: 13, unrecognizedChildCount: 11 }
    ])
  })

  it('reports live when a process still holds an inode that refuses connections', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof', 'HOLDER=91 yes 2 2'])
    )
    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('holder-process')
  })

  it('reports exited only when the connect was refused AND nothing holds the socket', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput([
        'PRESENT=yes',
        'LISTEN=refused',
        'FS_TYPE=linux ef53 ef53',
        'HOLDERS_SOURCE=lsof'
      ])
    )
    expect(incumbent.verdict).toBe('exited')
    expect(incumbent.evidence).toBe('no-holder')
    expect(incumbent.socketPresent).toBe(true)
  })

  it('reports exited for a refused socket on a macOS boot-volume filesystem or Linux tmpfs', () => {
    for (const fsType of ['darwin 1a 1a', 'Linux 1021994 ef53', 'darwin-mount apfs']) {
      const incumbent = parseRelayEndpointIncumbentProbe(
        SOCK,
        probeOutput(['PRESENT=yes', 'LISTEN=refused', `FS_TYPE=${fsType}`, 'HOLDERS_SOURCE=lsof'])
      )
      expect(incumbent.verdict).toBe('exited')
    }
  })

  // A relay on node A of a round-robin alias sharing an NFS home: node B's kernel refuses the
  // socket and B's lsof sees no holder, though A's relay still runs its terminals.
  it('reports unverifiable for a refused socket that another machine may hold', () => {
    for (const fsType of [
      'linux 6969 ef53', // nfs
      'linux ff534d42 ef53', // cifs
      'linux 65735546 ef53', // fuse (sshfs)
      'darwin 1c 1a', // macOS nfs/smbfs
      'darwin-mount nfs',
      'darwin-mount smbfs',
      'darwin-mount ', // no mount line matched
      'linux  ', // statfs unavailable
      'freebsd 35 35'
    ]) {
      const incumbent = parseRelayEndpointIncumbentProbe(
        SOCK,
        probeOutput(['PRESENT=yes', 'LISTEN=refused', `FS_TYPE=${fsType}`, 'HOLDERS_SOURCE=lsof'])
      )
      expect(incumbent.verdict).toBe('unverifiable')
    }
    const withoutType = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof'])
    )
    expect(withoutType.verdict).toBe('unverifiable')
  })

  it('still reports exited for a socket path that no longer exists, on any filesystem', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=no', 'LISTEN=absent', 'FS_TYPE=linux 6969 ef53', 'HOLDERS_SOURCE=lsof'])
    )
    expect(incumbent.verdict).toBe('exited')
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
      probeOutput([
        'PRESENT=yes',
        'LISTEN=refused',
        'FS_TYPE=linux ef53 ef53',
        'HOLDERS_SOURCE=lsof',
        'HOLDER=- no unknown unknown'
      ])
    )
    expect(incumbent.holders).toEqual([])
    expect(incumbent.verdict).toBe('exited')
  })

  it('keeps an unreadable child count as null rather than zero', () => {
    const [holder] = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput([
        'PRESENT=yes',
        'LISTEN=accepted',
        'HOLDERS_SOURCE=lsof',
        'HOLDER=7 yes unknown unknown'
      ])
    ).holders
    expect(holder.childCount).toBeNull()
    expect(holder.unrecognizedChildCount).toBeNull()
  })

  it('keeps a holder line with no unrecognized-child field unreapable', () => {
    const incumbent = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=7 yes 0'])
    )
    expect(incumbent.holders[0].unrecognizedChildCount).toBeNull()
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })
})

describe('probeRelayEndpointIncumbent', () => {
  it('keeps the whole probe alive long enough to return a bounded lsof result', async () => {
    execCommand.mockResolvedValueOnce(
      probeOutput(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=unavailable'])
    )

    await probeRelayEndpointIncumbent(connection, POSIX_HOST, '/usr/bin/node', SOCK)

    expect(execCommand).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      wrapCommand: true,
      signal: undefined
    })
  })

  it('keeps a confirmed timeout or rejection unverifiable and unenumerable', async () => {
    execCommand.mockRejectedValueOnce(
      Object.assign(new Error('lsof timed out after 5s'), { sshChannelCloseConfirmed: true })
    )
    const incumbent = await probeRelayEndpointIncumbent(
      connection,
      POSIX_HOST,
      '/usr/bin/node',
      SOCK
    )
    expect(incumbent.verdict).toBe('unverifiable')
    expect(incumbent.holdersEnumerable).toBe(false)
    expect(incumbent.holders).toEqual([])
  })

  it('rethrows an unconfirmed termination instead of masking it as unverifiable', async () => {
    const unconfirmed = Object.assign(new Error('remote channel close was not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    execCommand.mockRejectedValueOnce(unconfirmed)

    await expect(
      probeRelayEndpointIncumbent(connection, POSIX_HOST, '/usr/bin/node', SOCK)
    ).rejects.toBe(unconfirmed)
  })

  it('does not shell out on Windows hosts, where the endpoint is a named pipe', async () => {
    execCommand.mockClear()
    const incumbent = await probeRelayEndpointIncumbent(connection, WINDOWS_HOST, 'node.exe', SOCK)
    expect(execCommand).not.toHaveBeenCalled()
    expect(incumbent.verdict).toBe('unverifiable')
  })
})

describe('relayEndpointIncumbentProbeCommand', () => {
  it('ANDs the lsof selectors so it cannot match unrelated unix-socket holders', () => {
    expect(RELAY_LSOF_PROBE_JS).toContain("['-t', '-a', '-U', process.argv[1]]")
  })

  it('never unlinks the relay endpoint', () => {
    const command = relayEndpointIncumbentProbeCommand('/usr/bin/node', SOCK)
    expect(command).not.toMatch(/\brm\b/)
  })

  it('bounds only lsof and keeps the connect-probe output available', () => {
    const command = relayEndpointIncumbentProbeCommand('/usr/bin/node', SOCK)
    expect(RELAY_LSOF_PROBE_JS).toContain("spawn('lsof'")
    expect(command).toContain('}, 5000)')
    expect(command).toContain("printf 'HOLDERS_SOURCE=unavailable\\n'")
    expect(command.indexOf("printf 'LISTEN=%s\\n'")).toBeLessThan(command.indexOf('child = spawn('))
  })
})

describe('isReapableRelayHusk', () => {
  const husk = parseRelayEndpointIncumbentProbe(
    SOCK,
    probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=500 yes 0 0'])
  )

  it('accepts a single proven relay holder with no unaccounted-for children', () => {
    expect(isReapableRelayHusk(husk)).toBe(true)
  })

  it('accepts a relay whose only children are its own service processes (#13614)', () => {
    const withServices = parseRelayEndpointIncumbentProbe(
      SOCK,
      probeOutput(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=500 yes 2 0'])
    )
    expect(withServices.holders[0].childCount).toBe(2)
    expect(isReapableRelayHusk(withServices)).toBe(true)
  })

  it('refuses a relay that still holds children it could not account for', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: true, childCount: 3, unrecognizedChildCount: 1 }]
      })
    ).toBe(false)
  })

  it('refuses a holder whose unrecognized-child count could not be read', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: null }]
      })
    ).toBe(false)
  })

  it('refuses a holder whose argv is not this relay at this socket', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [{ pid: 500, matchesRelayArgv: false, childCount: 0, unrecognizedChildCount: 0 }]
      })
    ).toBe(false)
  })

  it('refuses when more than one process holds the socket', () => {
    expect(
      isReapableRelayHusk({
        ...husk,
        holders: [
          { pid: 500, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: 0 },
          { pid: 501, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: 0 }
        ]
      })
    ).toBe(false)
  })

  it('refuses an unverifiable endpoint however empty it looks', () => {
    expect(isReapableRelayHusk({ ...husk, verdict: 'unverifiable' })).toBe(false)
    expect(isReapableRelayHusk({ ...husk, holdersEnumerable: false })).toBe(false)
  })
})
