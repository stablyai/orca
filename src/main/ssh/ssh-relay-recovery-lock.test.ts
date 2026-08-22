import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (value: string) => `'${value.replace(/'/g, "'\\''")}'`
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-relay-poll-delay', () => ({
  waitForRelayPollDelay: vi.fn().mockResolvedValue(undefined)
}))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  RELAY_RECOVERY_LOCK_MAX_ATTEMPTS,
  acquireRelayRecoveryLock,
  relayRecoveryLockPath,
  releaseRelayRecoveryLock
} from './ssh-relay-recovery-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const SOCK = '/home/user/.orca-remote/relay-0.1.0/relay-deadbeefdeadbeef.sock'
const mockExec = vi.mocked(execCommand)
const conn = {} as SshConnection

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockReset()
})

describe('relayRecoveryLockPath', () => {
  it('keys the lock on the socket, not the relay directory', () => {
    expect(relayRecoveryLockPath(SOCK)).toBe(`${SOCK}.recovery-lock`)
  })
})

describe('acquireRelayRecoveryLock', () => {
  async function acquireCommand(): Promise<string> {
    mockExec.mockResolvedValue('CREATED')
    await acquireRelayRecoveryLock(conn, LINUX, SOCK)
    return mockExec.mock.calls[0][1] as string
  }

  it('claims and publishes the owner in a single remote command', async () => {
    mockExec.mockResolvedValue('CREATED')
    await acquireRelayRecoveryLock(conn, LINUX, SOCK)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('emits a success verdict only after the owner file has been written', async () => {
    // Why: the whole point of combining the commands. If OK could precede the owner write, a peer
    // would observe a claimed-but-ownerless lock for a full round trip.
    const command = await acquireCommand()
    const ownerWrite = command.indexOf(`> '${SOCK}.recovery-lock/.owner'`)
    expect(ownerWrite).toBeGreaterThan(0)
    expect(command.indexOf('echo CREATED')).toBeGreaterThan(ownerWrite)
    expect(command.indexOf('echo STOLEN')).toBeGreaterThan(ownerWrite)
  })

  it('never lets the reused builders speak for the command', async () => {
    // Why: both builders emit their own OK/BUSY. Capturing each verdict keeps two answers off one
    // stdout, which an endsWith('OK') reader would otherwise mis-parse.
    const command = await acquireCommand()
    expect([...command.matchAll(/orca_claim=\$\(/g)]).toHaveLength(2)
    expect(command.trimEnd().endsWith('echo BUSY')).toBe(true)
  })

  it('removes only the directory it just created when publication fails', async () => {
    const command = await acquireCommand()
    const publishFailure = command.indexOf('else rm -rf')
    expect(publishFailure).toBeGreaterThan(0)
    // Why bounded: the command ends with an unconditional `echo BUSY`, so slicing to the end would
    // pass even if this branch emitted a success verdict — which would hand out an unowned lock.
    const branch = command.slice(publishFailure, command.indexOf('fi', publishFailure))
    expect(branch).toContain('echo BUSY')
    expect(branch).not.toContain('CREATED')
    expect(branch).not.toContain('STOLEN')
  })

  it('reports an uncontended acquire as not having waited', async () => {
    mockExec.mockResolvedValue('CREATED')
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toMatchObject({
      waited: false
    })
  })

  it('treats a stale steal as having waited even on the first attempt', async () => {
    // Why: a steal takes over from a holder that may already have relaunched the relay before
    // dying, so this caller must re-probe rather than reap what could be a healthy successor.
    mockExec.mockResolvedValue('STOLEN')
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toMatchObject({
      waited: true
    })
  })

  it('reports a queued acquire as having waited', async () => {
    let attempts = 0
    mockExec.mockImplementation(() => {
      attempts += 1
      return Promise.resolve(attempts === 1 ? 'BUSY' : 'CREATED')
    })
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toMatchObject({
      waited: true
    })
  })

  it('carries the stale window into the steal it composes', async () => {
    const command = await acquireCommand()
    expect(command).toContain(`${20 * 60}`)
    expect(command).toContain('.recovery-lock.steal')
  })

  it('gives up rather than proceeding unserialized when the lock stays held', async () => {
    mockExec.mockResolvedValue('BUSY')
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toBeNull()
    expect(mockExec).toHaveBeenCalledTimes(RELAY_RECOVERY_LOCK_MAX_ATTEMPTS)
  })

  it('bounds every command taken while the lock is held', async () => {
    mockExec.mockResolvedValue('CREATED')
    await acquireRelayRecoveryLock(conn, LINUX, SOCK)
    for (const call of mockExec.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: expect.any(Number) })
    }
  })

  it('drops a lock it cannot prove it owns when the claim reply is lost', async () => {
    const commands: string[] = []
    mockExec.mockImplementation((_conn, command: string) => {
      commands.push(command)
      if (commands.length === 1) {
        return Promise.reject(new Error('claim reply lost'))
      }
      return Promise.resolve('RELEASED')
    })
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).rejects.toThrow(/claim reply/)
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain('LOST')
  })

  it('refuses Windows hosts rather than emitting POSIX-only glue', async () => {
    await expect(acquireRelayRecoveryLock(conn, WINDOWS, SOCK)).rejects.toThrow(/POSIX-only/)
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('releaseRelayRecoveryLock', () => {
  async function releaseCommand(): Promise<string> {
    mockExec.mockResolvedValue('RELEASED')
    await releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')
    return mockExec.mock.calls[0][1] as string
  }

  it('refuses to delete a lock directory that has no owner file', async () => {
    // Why: an ownerless lock is a successor still publishing inside its own claim command, or a
    // claim whose shell died mid-publish. Deleting it would hand two clients the same socket.
    const command = await releaseCommand()
    const ownerless = command.indexOf(`! -f '${SOCK}.recovery-lock/.owner'`)
    expect(ownerless).toBeGreaterThan(0)
    expect(command.slice(ownerless, command.indexOf('elif', ownerless + 1))).toContain('echo LOST')
    expect(command.slice(ownerless, command.indexOf('elif', ownerless + 1))).not.toContain('rm -rf')
  })

  it('removes the lock on exactly one branch, after the token matched', async () => {
    const command = await releaseCommand()
    const removals = [...command.matchAll(/rm -rf/g)]
    expect(removals).toHaveLength(1)
    expect((removals[0].index as number) > command.indexOf("'token-1'")).toBe(true)
  })

  it.each([
    ['RELEASED', 'released'],
    ['LOST', 'lost'],
    ['nonsense', 'unknown']
  ])('maps a %s reply', async (reply, expected) => {
    mockExec.mockResolvedValue(reply)
    await expect(releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')).resolves.toBe(expected)
  })

  it('refuses to remove a lock another client already stole', async () => {
    const command = await releaseCommand()
    expect(command).toContain('LOST')
    expect(command).toContain("'token-1'")
  })

  it('runs without the caller signal so an abort cannot leak the lock', async () => {
    mockExec.mockResolvedValue('RELEASED')
    await releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')
    expect(mockExec.mock.calls[0][2]).toMatchObject({ timeoutMs: expect.any(Number) })
    expect(mockExec.mock.calls[0][2]).not.toHaveProperty('signal')
  })

  it('never rejects, so it is safe in a finally', async () => {
    mockExec.mockRejectedValue(new Error('transport gone'))
    await expect(releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')).resolves.toBe('unknown')
  })
})
