import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock, isRelayInstallLockStale } from './ssh-relay-install-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked execCommand never reads the connection.
const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)
const nextAcquisition = ['OPEN', '', 'OK', 'OPEN']

const lockFailureStages = [
  {
    stage: 'claim probe after acquisition',
    replies: ['OPEN', '', 'OK'],
    recovery: ['', 'OK', 'OPEN']
  },
  {
    stage: 'release after acquisition',
    replies: ['OPEN', '', 'OK', 'LOCKED'],
    recovery: ['OK', 'OPEN']
  },
  {
    stage: 'stale lock takeover',
    replies: ['OPEN', '', 'BUSY'],
    recovery: nextAcquisition
  },
  {
    stage: 'claim probe after stale takeover',
    replies: ['OPEN', '', 'BUSY', 'OK'],
    recovery: ['', ...nextAcquisition]
  },
  {
    stage: 'release after stale takeover',
    replies: ['OPEN', '', 'BUSY', 'OK', 'LOCKED'],
    recovery: nextAcquisition
  }
]

beforeEach(() => {
  mockExec.mockReset()
  mockExec.mockResolvedValue('OPEN')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each([
  { platform: 'linux-x64' as const, remoteDir: '/relay/version' },
  { platform: 'win32-x64' as const, remoteDir: 'C:/relay/version' }
])('install lock termination on $platform', ({ platform, remoteDir }) => {
  const host = getRemoteHostPlatform(platform)

  it.each(lockFailureStages)('stops after unconfirmed $stage', async ({ replies }) => {
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    for (const reply of replies) {
      mockExec.mockResolvedValueOnce(reply)
    }
    mockExec.mockRejectedValueOnce(error)

    await expect(acquireInstallLock(conn, remoteDir, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(replies.length + 1)
  })

  it.each(lockFailureStages)(
    'keeps recovery after confirmed $stage failure',
    async ({ replies, recovery }) => {
      vi.useFakeTimers()
      for (const reply of replies) {
        mockExec.mockResolvedValueOnce(reply)
      }
      mockExec.mockRejectedValueOnce(
        Object.assign(new Error('SSH command failed after closing'), {
          sshChannelCloseConfirmed: true
        })
      )
      for (const reply of recovery) {
        mockExec.mockResolvedValueOnce(reply)
      }

      const acquiring = acquireInstallLock(conn, remoteDir, host)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(acquiring).resolves.toBeUndefined()
      expect(mockExec).toHaveBeenCalledTimes(replies.length + recovery.length + 1)
    }
  )

  it('preserves takeover uncertainty when the caller also aborts', async () => {
    const controller = new AbortController()
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('BUSY')
      .mockImplementationOnce(async () => {
        controller.abort(new Error('deploy aborted'))
        throw error
      })

    await expect(
      acquireInstallLock(conn, remoteDir, host, { signal: controller.signal })
    ).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  it('preserves uncertainty from the stale lock age probe', async () => {
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    mockExec.mockRejectedValueOnce(error)

    await expect(isRelayInstallLockStale(conn, remoteDir, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('keeps a confirmed stale age probe failure as not stale', async () => {
    mockExec.mockRejectedValueOnce(
      Object.assign(new Error('SSH command failed after closing'), {
        sshChannelCloseConfirmed: true
      })
    )

    await expect(isRelayInstallLockStale(conn, remoteDir, host)).resolves.toBe(false)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })
})
