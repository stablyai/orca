import { beforeEach, describe, expect, it, vi } from 'vitest'

const execCommand = vi.fn()
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: (...args: unknown[]) => execCommand(...args),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    (error as { sshChannelCloseConfirmed?: boolean } | null)?.sshChannelCloseConfirmed === false
}))

import { parseRelayEndpointIncumbentProbe } from './ssh-relay-endpoint-incumbent'
import {
  classifySupersededRelay,
  supersededRelayEndpointListCommand,
  sweepSupersededRelayEndpoints
} from './ssh-relay-superseded-endpoints'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const HOME = '/home/u'
const SOCK_NAME = 'relay-deadbeef.sock'
const CURRENT_DIR = `${HOME}/.orca-remote/relay-0.1.0+bd3ec370d21d`
const OLD_SOCK = `${HOME}/.orca-remote/relay-0.1.0+7175e0a40ea7/${SOCK_NAME}`
const HOST = getRemoteHostPlatform('linux-x64')
const WINDOWS_HOST = getRemoteHostPlatform('win32-x64')
const CONN = {} as SshConnection

const SWEEP = {
  remoteHome: HOME,
  currentRelayDir: CURRENT_DIR,
  sockName: SOCK_NAME,
  nodePath: '/usr/bin/node'
}

function probe(lines: string[]): string {
  return ['ORCA-INCUMBENT-BEGIN', ...lines, 'ORCA-INCUMBENT-END'].join('\n')
}

function incumbent(lines: string[]): ReturnType<typeof parseRelayEndpointIncumbentProbe> {
  return parseRelayEndpointIncumbentProbe(OLD_SOCK, probe(lines))
}

function issuedCommands(): string[] {
  return execCommand.mock.calls.map((call) => String(call[1]))
}

beforeEach(() => {
  execCommand.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('supersededRelayEndpointListCommand', () => {
  it('globs sibling version dirs for this target socket and skips the current one', () => {
    const command = supersededRelayEndpointListCommand(SWEEP)
    expect(command).toContain('"$base"/relay-*/"$sock_name"')
    expect(command).toContain('[ "$dir" = "$current" ] && continue')
    expect(command).toContain(SOCK_NAME)
    expect(command).toContain(CURRENT_DIR)
  })
})

describe('classifySupersededRelay', () => {
  it('retains a live relay that still owns PTYs', () => {
    expect(
      classifySupersededRelay(
        incumbent([
          'PRESENT=yes',
          'LISTEN=accepted',
          'HOLDERS_SOURCE=lsof',
          'HOLDER=3669803 yes 13'
        ])
      )
    ).toBe('retained-live-work')
  })

  it('nominates only a proven empty relay for reaping', () => {
    expect(
      classifySupersededRelay(
        incumbent(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
    ).toBe('reap-candidate')
  })

  it('removes only a socket proven to have no holder', () => {
    expect(
      classifySupersededRelay(incumbent(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof']))
    ).toBe('stale-endpoint-removed')
  })

  it('does nothing at all for an unverifiable endpoint', () => {
    expect(
      classifySupersededRelay(
        incumbent(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=unavailable'])
      )
    ).toBe('unverifiable')
  })
})

describe('sweepSupersededRelayEndpoints', () => {
  it('leaves an upgrade-orphaned relay that still owns terminals running, untouched', async () => {
    execCommand
      .mockResolvedValueOnce(`${OLD_SOCK}\n`)
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=3669803 yes 13'])
      )
    const findings = await sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ sockPath: OLD_SOCK, outcome: 'retained-live-work' })
    expect(issuedCommands().some((command) => /\bkill\b/.test(command))).toBe(false)
    expect(issuedCommands().some((command) => /\brm -f\b/.test(command))).toBe(false)
  })

  it('reaps the empty husk an upgrade leaves behind, once the host confirms it is gone', async () => {
    execCommand
      .mockResolvedValueOnce(`${OLD_SOCK}\n`)
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
      .mockResolvedValueOnce('GONE\n')
    const findings = await sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)
    expect(findings[0].outcome).toBe('reaped')
    expect(issuedCommands()[2]).toContain('kill -TERM "$pid"')
  })

  it('reports reap-unconfirmed rather than reaped when the pid is still there', async () => {
    execCommand
      .mockResolvedValueOnce(`${OLD_SOCK}\n`)
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
      .mockResolvedValueOnce('LIVE\n')
    const findings = await sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)
    expect(findings[0].outcome).toBe('reap-unconfirmed')
  })

  it('unlinks an orphaned socket only once nothing holds it, unpinning the dir for GC', async () => {
    execCommand
      .mockResolvedValueOnce(`${OLD_SOCK}\n`)
      .mockResolvedValueOnce(probe(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof']))
      .mockResolvedValueOnce('')
    const findings = await sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)
    expect(findings[0].outcome).toBe('stale-endpoint-removed')
    expect(issuedCommands()[2]).toBe(`rm -f '${OLD_SOCK}'`)
  })

  it('touches nothing on a host it cannot interrogate', async () => {
    execCommand
      .mockResolvedValueOnce(`${OLD_SOCK}\n`)
      .mockResolvedValueOnce(probe(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=unavailable']))
    const findings = await sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)
    expect(findings[0].outcome).toBe('unverifiable')
    expect(issuedCommands()).toHaveLength(2)
  })

  it('is a no-op when the listing fails, and never guesses at what was there', async () => {
    execCommand.mockRejectedValueOnce(new Error('exec failed'))
    await expect(sweepSupersededRelayEndpoints(CONN, HOST, SWEEP)).resolves.toEqual([])
  })

  it('does not run against Windows hosts, whose endpoints are named pipes', async () => {
    await expect(sweepSupersededRelayEndpoints(CONN, WINDOWS_HOST, SWEEP)).resolves.toEqual([])
    expect(execCommand).not.toHaveBeenCalled()
  })
})
