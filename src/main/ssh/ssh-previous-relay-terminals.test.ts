import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { RelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { execCommand, probeRelayEndpointIncumbent, probeRelayVersionDirLiveness } = vi.hoisted(
  () => ({
    execCommand: vi.fn(),
    probeRelayEndpointIncumbent: vi.fn(),
    probeRelayVersionDirLiveness: vi.fn()
  })
)

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./remote-install-gc', () => ({ probeRelayVersionDirLiveness }))
vi.mock('./ssh-relay-endpoint-incumbent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeRelayEndpointIncumbent
}))

import {
  clearPreviousRelayCensus,
  isReattachHeldByPreviousRelay,
  mayHoldTerminals,
  previousRelayCensus,
  startPreviousRelayCensus
} from './ssh-previous-relay-terminals'

// The census only hands the connection to the mocked exec and probe.
const conn: SshConnection = Object.create(null)
const OLD_SOCK = '/home/dev/.orca-remote/relay-0.1.0+old/relay-abc.sock'
const deployed = {
  hostPlatform: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/dev',
  remoteRelayDir: '/home/dev/.orca-remote/relay-0.1.0+new',
  nodePath: '/usr/bin/node',
  sockPath: '/home/dev/.orca-remote/relay-0.1.0+new/relay-abc.sock'
}

function incumbent(overrides: Partial<RelayEndpointIncumbent>): RelayEndpointIncumbent {
  return {
    sockPath: OLD_SOCK,
    verdict: 'live',
    evidence: 'accepted-connection',
    socketPresent: true,
    holders: [],
    holdersEnumerable: false,
    ...overrides
  }
}

const notFound = new Error('PTY "pty2:old-epoch:1" not found')

describe('previous relay terminals', () => {
  beforeEach(() => {
    execCommand.mockReset()
    probeRelayEndpointIncumbent.mockReset()
    probeRelayVersionDirLiveness.mockReset()
    clearPreviousRelayCensus('target-1')
  })

  it('treats a live or unverifiable older relay as possibly holding terminals', () => {
    expect(mayHoldTerminals(incumbent({}))).toBe(true)
    expect(mayHoldTerminals(incumbent({ verdict: 'unverifiable' }))).toBe(true)
    expect(mayHoldTerminals(incumbent({ verdict: 'exited', socketPresent: false }))).toBe(false)
  })

  it('does not hold for an older relay proven to hold nothing', () => {
    const husk = incumbent({
      holdersEnumerable: true,
      holders: [{ pid: 42, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: 0 }]
    })
    expect(mayHoldTerminals(husk)).toBe(false)
  })

  it('lists older endpoints for this target only, excluding the relay just launched', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))

    await expect(startPreviousRelayCensus(conn, 'target-1', deployed)).resolves.toMatchObject({
      endpoints: [OLD_SOCK],
      complete: true,
      bridgeable: true
    })

    const listing = execCommand.mock.calls[0][1]
    expect(listing).toContain("current='/home/dev/.orca-remote/relay-0.1.0+new'")
    expect(probeRelayEndpointIncumbent).toHaveBeenCalledWith(
      conn,
      deployed.hostPlatform,
      '/usr/bin/node',
      OLD_SOCK
    )
  })

  it('finds nothing to hold on a host with no older relay', async () => {
    execCommand.mockResolvedValue('')
    await expect(startPreviousRelayCensus(conn, 'target-1', deployed)).resolves.toMatchObject({
      endpoints: [],
      complete: true
    })
    expect(probeRelayEndpointIncumbent).not.toHaveBeenCalled()
  })

  it("probes each older version directory's Windows pipe for this target", async () => {
    const windows = {
      ...deployed,
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:\\Users\\dev',
      remoteRelayDir: 'C:\\Users\\dev\\.orca-remote\\relay-0.1.0+ccc',
      nodePath: 'C:\\node\\node.exe'
    }
    execCommand.mockResolvedValue('relay-0.1.0+aaa\nrelay-0.1.0+bbb\nrelay-0.1.0+ccc\n')
    probeRelayVersionDirLiveness.mockImplementation(async (_conn, dir: string) =>
      dir.endsWith('relay-0.1.0+aaa') ? 'live' : 'exited'
    )

    const census = await startPreviousRelayCensus(conn, 'target-1', windows)

    expect(census).toMatchObject({
      endpoints: [expect.stringMatching(/relay-0\.1\.0\+aaa$/)],
      complete: true,
      unverifiable: false,
      bridgeable: false
    })
    expect(probeRelayVersionDirLiveness).toHaveBeenCalledTimes(2)
    expect(probeRelayVersionDirLiveness).toHaveBeenCalledWith(
      conn,
      expect.stringMatching(/relay-0\.1\.0\+aaa$/),
      windows.hostPlatform,
      expect.objectContaining({ windowsNodePath: windows.nodePath })
    )
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(true)
  })

  it('holds a not-found reattach while an older relay may run it', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))
    startPreviousRelayCensus(conn, 'target-1', deployed)

    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(true)
  })

  it('does not hold a refusal that is not a plain not-found', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))
    startPreviousRelayCensus(conn, 'target-1', deployed)

    const mismatch = new Error('PTY "pty2:old-epoch:1" not found (identity mismatch)')
    await expect(isReattachHeldByPreviousRelay('target-1', mismatch)).resolves.toBe(false)
    await expect(
      isReattachHeldByPreviousRelay('target-1', new Error('Request timed out'))
    ).resolves.toBe(false)
  })

  it('keeps the existing path when no census started, or no older Windows relay is live', async () => {
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(false)

    execCommand.mockResolvedValue('relay-0.1.0+bbb\n')
    probeRelayVersionDirLiveness.mockResolvedValue('exited')
    startPreviousRelayCensus(conn, 'target-1', {
      ...deployed,
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(false)
  })

  it.each([
    ['could not run', () => execCommand.mockRejectedValue(new Error('channel closed')), deployed],
    ['had no node to probe with', () => {}, { ...deployed, nodePath: undefined }],
    ['did not know the host platform', () => {}, { ...deployed, hostPlatform: undefined }],
    [
      'listed more endpoints than it probes',
      () => {
        execCommand.mockResolvedValue(
          Array.from({ length: 33 }, (_, i) => `/home/dev/.orca-remote/relay-${i}/r.sock`).join(
            '\n'
          )
        )
        probeRelayEndpointIncumbent.mockResolvedValue(incumbent({ verdict: 'exited' }))
      },
      deployed
    ]
  ])('holds a not-found reattach when the census %s', async (_label, arrange, input) => {
    arrange()
    startPreviousRelayCensus(conn, 'target-1', input)

    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({
      complete: false,
      unverifiable: true
    })
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(true)
  })

  it('marks a census complete only when every endpoint of an enumerable host was censused', async () => {
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: false })

    execCommand.mockResolvedValue('')
    startPreviousRelayCensus(conn, 'target-1', deployed)
    await expect(previousRelayCensus('target-1')).resolves.toEqual({
      endpoints: [],
      nodePath: deployed.nodePath,
      complete: true,
      unverifiable: false,
      bridgeable: true
    })
  })

  it("forgets a session's census on teardown without dropping a newer deploy's", async () => {
    execCommand.mockResolvedValue('')
    const older = startPreviousRelayCensus(conn, 'target-1', deployed)
    const newer = startPreviousRelayCensus(conn, 'target-1', deployed)

    clearPreviousRelayCensus('target-1', older)
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: true })
    clearPreviousRelayCensus('target-1', newer)
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: false })
  })
})
