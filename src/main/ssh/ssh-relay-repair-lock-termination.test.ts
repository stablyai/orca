import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked execCommand never reads the connection.
const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)
const freshLockReplies = ['OPEN', 'LOCKED', '0']
const contentionReplies = ['OPEN', '', 'BUSY', 'BUSY']

const failureStages = [
  { stage: 'initial claim probe', replies: [], recovery: [], result: 'error' },
  { stage: 'parent creation', replies: ['OPEN'], recovery: freshLockReplies, result: 'busy' },
  { stage: 'lock creation', replies: ['OPEN', ''], recovery: freshLockReplies, result: 'busy' },
  {
    stage: 'stale takeover',
    replies: ['OPEN', '', 'BUSY'],
    recovery: freshLockReplies,
    result: 'busy'
  },
  {
    stage: 'claim probe after creation',
    replies: ['OPEN', '', 'OK'],
    recovery: [''],
    result: 'error'
  },
  {
    stage: 'release after creation',
    replies: ['OPEN', '', 'OK', 'LOCKED'],
    recovery: [],
    result: 'gc'
  },
  {
    stage: 'claim probe after takeover',
    replies: ['OPEN', '', 'BUSY', 'OK'],
    recovery: [''],
    result: 'error'
  },
  {
    stage: 'release after takeover',
    replies: ['OPEN', '', 'BUSY', 'OK', 'LOCKED'],
    recovery: [],
    result: 'gc'
  },
  { stage: 'contention claim probe', replies: contentionReplies, recovery: [], result: 'error' },
  {
    stage: 'contention lock probe',
    replies: [...contentionReplies, 'OPEN'],
    recovery: [],
    result: 'error'
  },
  {
    stage: 'contention lock age probe',
    replies: [...contentionReplies, 'OPEN', 'LOCKED'],
    recovery: [],
    result: 'error'
  }
]

beforeEach(() => {
  mockExec.mockReset()
  mockExec.mockResolvedValue('OPEN')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each([
  { platform: 'linux-x64' as const, remoteDir: '/relay/version' },
  { platform: 'win32-x64' as const, remoteDir: 'C:/relay/version' }
])('repair lock termination on $platform', ({ platform, remoteDir }) => {
  const host = getRemoteHostPlatform(platform)

  describe.each([false, true])('with caller aborted = %s', (aborted) => {
    it.each(failureStages)('stops after unconfirmed $stage', async ({ replies }) => {
      const controller = new AbortController()
      const error = Object.assign(new Error('SSH teardown not confirmed'), {
        sshChannelCloseConfirmed: false
      })
      for (const reply of replies) {
        mockExec.mockResolvedValueOnce(reply)
      }
      mockExec.mockImplementationOnce(async () => {
        if (aborted) {
          controller.abort(new Error('deploy aborted'))
        }
        throw error
      })

      await expect(
        tryAcquireRelayRepairLock(conn, remoteDir, host, { signal: controller.signal })
      ).rejects.toBe(error)
      expect(mockExec).toHaveBeenCalledTimes(replies.length + 1)
    })
  })

  it.each(failureStages)(
    'keeps recovery after confirmed $stage failure',
    async ({ replies, recovery, result }) => {
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

      await expect(tryAcquireRelayRepairLock(conn, remoteDir, host)).resolves.toBe(result)
      expect(mockExec).toHaveBeenCalledTimes(replies.length + recovery.length + 1)
    }
  )

  it('stops when a contention probe after a confirmed acquisition failure is unconfirmed', async () => {
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    mockExec
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('lock creation failed'))
      .mockRejectedValueOnce(error)

    await expect(tryAcquireRelayRepairLock(conn, remoteDir, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(4)
  })
})
