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
  it('reports an uncontended acquire as not having waited', async () => {
    mockExec.mockResolvedValue('OK')
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toMatchObject({
      waited: false
    })
  })

  it('reports a queued acquire as having waited', async () => {
    let attempts = 0
    mockExec.mockImplementation((_conn, command: string) => {
      if (command.startsWith('mkdir ')) {
        attempts += 1
        return Promise.resolve(attempts === 1 ? 'BUSY' : 'OK')
      }
      if (command.includes('.steal')) {
        return Promise.resolve('BUSY')
      }
      return Promise.resolve('')
    })
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toMatchObject({
      waited: true
    })
  })

  it('gives up rather than proceeding unserialized when the lock stays held', async () => {
    mockExec.mockResolvedValue('BUSY')
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).resolves.toBeNull()
    const mkdirs = mockExec.mock.calls.filter(([, command]) =>
      (command as string).startsWith('mkdir ')
    )
    expect(mkdirs).toHaveLength(RELAY_RECOVERY_LOCK_MAX_ATTEMPTS)
  })

  it('bounds every command taken while the lock is held', async () => {
    mockExec.mockResolvedValue('OK')
    await acquireRelayRecoveryLock(conn, LINUX, SOCK)
    for (const call of mockExec.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: expect.any(Number) })
    }
  })

  it('drops a lock it cannot prove it owns when the owner write fails', async () => {
    const released: string[] = []
    mockExec.mockImplementation((_conn, command: string) => {
      if (command.startsWith('mkdir ')) {
        return Promise.resolve('OK')
      }
      if (command.startsWith('printf %s ')) {
        return Promise.reject(new Error('owner write lost its reply'))
      }
      released.push(command)
      return Promise.resolve('RELEASED')
    })
    await expect(acquireRelayRecoveryLock(conn, LINUX, SOCK)).rejects.toThrow(/owner write/)
    expect(released).toHaveLength(1)
  })
})

describe('releaseRelayRecoveryLock', () => {
  async function releaseCommand(): Promise<string> {
    mockExec.mockResolvedValue('RELEASED')
    await releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')
    return mockExec.mock.calls[0][1] as string
  }

  it('reclaims a lock directory that never got an owner file', async () => {
    // Why: an ownerless lock was never claimed by anyone. Reporting it LOST would block every
    // client for the whole staleness window over a create whose owner write lost its reply.
    const command = await releaseCommand()
    const ownerless = command.indexOf(`! -e '${SOCK}.recovery-lock/.owner'`)
    const tokenCheck = command.indexOf('token-1')
    expect(ownerless).toBeGreaterThan(0)
    expect(tokenCheck).toBeGreaterThan(ownerless)
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
    await expect(releaseRelayRecoveryLock(conn, LINUX, SOCK, 'token-1')).resolves.toBeUndefined()
  })
})
