import { beforeEach, describe, expect, it, vi } from 'vitest'

const execCommand = vi.fn()
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: (...args: unknown[]) => execCommand(...args),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    (error as { sshChannelCloseConfirmed?: boolean } | null)?.sshChannelCloseConfirmed === false
}))

import { isRelayEndpointHeldError } from './ssh-relay-endpoint-incumbent'
import {
  interpretRelayHuskReapOutput,
  reapEmptyRelayHuskCommand,
  resolveRelayEndpointBeforeRelaunch
} from './ssh-relay-endpoint-takeover'
import { RelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SOCK = '/home/u/.orca-remote/relay-0.1.0+aaaa/relay-deadbeef.sock'
const HOST = getRemoteHostPlatform('linux-x64')
const CONN = {} as SshConnection

function probe(lines: string[]): string {
  return ['ORCA-INCUMBENT-BEGIN', ...lines, 'ORCA-INCUMBENT-END'].join('\n')
}

function issuedCommands(): string[] {
  return execCommand.mock.calls.map((call) => String(call[1]))
}

function resolve(reconnectError: unknown = new Error('connect failed')): Promise<unknown> {
  return resolveRelayEndpointBeforeRelaunch(CONN, HOST, '/usr/bin/node', SOCK, reconnectError)
}

beforeEach(() => {
  execCommand.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('incumbent alive and refusing', () => {
  it('refuses to rebind a live relay holding PTYs, and signals nothing', async () => {
    execCommand.mockResolvedValueOnce(
      probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=3669803 yes 13'])
    )
    await expect(resolve()).rejects.toSatisfy(isRelayEndpointHeldError)
    // The whole point of #8585: the incumbent's socket must survive so it is not orphaned.
    expect(issuedCommands().some((command) => /\brm -f\b/.test(command))).toBe(false)
    expect(issuedCommands().some((command) => /\bkill\b/.test(command))).toBe(false)
  })

  it('names the incumbent pid and the Reset Relay escape hatch in the error', async () => {
    execCommand.mockResolvedValue(
      probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=3669803 yes 13'])
    )
    await expect(resolve()).rejects.toThrow(/3669803\(children=13\)/)
    await expect(resolve()).rejects.toThrow(/Reset Relay/)
  })

  it('treats a version mismatch as live even where holders cannot be enumerated', async () => {
    execCommand.mockResolvedValue(
      probe(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=unavailable'])
    )
    const mismatch = new RelayVersionMismatchError('0.1.0+new', '0.1.0+old', '')
    await expect(resolve(mismatch)).rejects.toSatisfy(isRelayEndpointHeldError)
    expect(issuedCommands().some((command) => /\brm -f\b/.test(command))).toBe(false)
  })

  it('reaps a live relay only when it provably holds nothing, and confirms it is gone', async () => {
    execCommand
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
      .mockResolvedValueOnce('GONE\n')
    await expect(resolve()).resolves.toMatchObject({ verdict: 'live' })
    expect(issuedCommands()[1]).toContain('kill -TERM "$pid"')
  })

  it('does not launch over an empty relay whose death could not be confirmed', async () => {
    execCommand
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
      .mockResolvedValueOnce('LIVE\n')
    await expect(resolve()).rejects.toSatisfy(isRelayEndpointHeldError)
  })

  it('does not launch over a relay the host refused to signal on its own re-check', async () => {
    execCommand
      .mockResolvedValueOnce(
        probe(['PRESENT=yes', 'LISTEN=accepted', 'HOLDERS_SOURCE=lsof', 'HOLDER=80583 yes 0'])
      )
      .mockResolvedValueOnce('BUSY\n')
    await expect(resolve()).rejects.toSatisfy(isRelayEndpointHeldError)
  })
})

describe('incumbent genuinely gone', () => {
  it('permits the relaunch without unlinking anything itself', async () => {
    execCommand.mockResolvedValueOnce(
      probe(['PRESENT=yes', 'LISTEN=refused', 'HOLDERS_SOURCE=lsof'])
    )
    await expect(resolve()).resolves.toMatchObject({ verdict: 'exited', evidence: 'no-holder' })
    // The daemon unlinks under an identity check that is atomic with its bind; the client
    // cannot be, which is what created the orphan in the first place.
    expect(issuedCommands().some((command) => /\brm -f\b/.test(command))).toBe(false)
  })
})

describe('incumbent unverifiable', () => {
  it('permits the relaunch but never claims the incumbent exited', async () => {
    execCommand.mockResolvedValueOnce(
      probe(['PRESENT=yes', 'LISTEN=unknown', 'HOLDERS_SOURCE=unavailable'])
    )
    await expect(resolve()).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(issuedCommands()).toHaveLength(1)
  })

  it('stays unverifiable when the probe command itself fails', async () => {
    execCommand.mockRejectedValueOnce(new Error('exec timeout'))
    await expect(resolve()).resolves.toMatchObject({ verdict: 'unverifiable' })
  })
})

describe('reapEmptyRelayHuskCommand', () => {
  it('re-verifies argv and emptiness on the host immediately before signalling', () => {
    const command = reapEmptyRelayHuskCommand(4242, SOCK)
    expect(command.indexOf('MISMATCH')).toBeLessThan(command.indexOf('kill -TERM'))
    expect(command.indexOf('BUSY')).toBeLessThan(command.indexOf('kill -TERM'))
  })

  it('sends SIGTERM only, so the relay runs its own socket cleanup', () => {
    const command = reapEmptyRelayHuskCommand(4242, SOCK)
    expect(command).toContain('kill -TERM')
    expect(command).not.toContain('kill -KILL')
    expect(command).not.toContain('-9')
  })

  it('aborts without signalling when the host cannot count children', () => {
    expect(reapEmptyRelayHuskCommand(4242, SOCK)).toContain(
      "command -v pgrep >/dev/null 2>&1 || { printf 'BUSY\\n'; exit 0; }"
    )
  })
})

describe('interpretRelayHuskReapOutput', () => {
  it('claims reaped only for a post-signal liveness check that failed', () => {
    expect(interpretRelayHuskReapOutput('GONE\n')).toBe('reaped')
    expect(interpretRelayHuskReapOutput('LIVE\n')).toBe('reap-unconfirmed')
    expect(interpretRelayHuskReapOutput('')).toBe('reap-unconfirmed')
    expect(interpretRelayHuskReapOutput('unexpected noise')).toBe('reap-unconfirmed')
  })

  it('reports a host-side refusal as retained rather than as a failed kill', () => {
    expect(interpretRelayHuskReapOutput('MISMATCH\n')).toBe('retained-live-work')
    expect(interpretRelayHuskReapOutput('BUSY\n')).toBe('retained-live-work')
  })
})
