import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  isRelayGcClaimOwned,
  releaseRelayGcClaim,
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim,
  waitForRelayGcClaimRelease
} from './ssh-relay-gc-claim'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked execCommand never reads the connection.
const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)
const token = 'claim-owner'

function unconfirmedTermination(): Error {
  return Object.assign(new Error('SSH teardown not confirmed'), {
    sshChannelCloseConfirmed: false
  })
}

function confirmedFailure(): Error {
  return Object.assign(new Error('SSH command failed after closing'), {
    sshChannelCloseConfirmed: true
  })
}

beforeEach(() => {
  mockExec.mockReset()
  mockExec.mockResolvedValue('OPEN')
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each([
  { platform: 'linux-x64' as const, remoteDir: '/relay/version' },
  { platform: 'win32-x64' as const, remoteDir: 'C:/relay/version' }
])('relay GC claim termination on $platform', ({ platform, remoteDir }) => {
  const host = getRemoteHostPlatform(platform)

  it.each([
    { stage: 'claim creation', replies: [] },
    { stage: 'stale claim takeover', replies: ['BUSY'] },
    { stage: 'new claim owner write', replies: ['OK'] },
    { stage: 'recovered claim owner write', replies: ['BUSY', 'OK'] }
  ])('preserves uncertainty during $stage without releasing or retrying', async ({ replies }) => {
    const error = unconfirmedTermination()
    for (const reply of replies) {
      mockExec.mockResolvedValueOnce(reply)
    }
    mockExec.mockRejectedValueOnce(error)

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host)).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(replies.length + 1)
  })

  it('preserves acquisition uncertainty when the caller also aborts', async () => {
    const controller = new AbortController()
    const error = unconfirmedTermination()
    mockExec.mockImplementationOnce(async () => {
      controller.abort(new Error('deploy aborted'))
      throw error
    })

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host, controller.signal)).rejects.toBe(
      error
    )
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('preserves ownership probe uncertainty', async () => {
    const error = unconfirmedTermination()
    mockExec.mockRejectedValueOnce(error)

    await expect(isRelayGcClaimOwned(conn, remoteDir, token, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('preserves release uncertainty', async () => {
    const error = unconfirmedTermination()
    mockExec.mockRejectedValueOnce(error)

    await expect(releaseRelayGcClaim(conn, remoteDir, token, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1])(
    'stops release retries after %i confirmed failures then uncertainty',
    async (n) => {
      const error = unconfirmedTermination()
      for (let attempt = 0; attempt < n; attempt++) {
        mockExec.mockRejectedValueOnce(confirmedFailure())
      }
      mockExec.mockRejectedValueOnce(error)

      await expect(releaseRelayGcClaimWithRetry(conn, remoteDir, token, host)).rejects.toBe(error)
      expect(mockExec).toHaveBeenCalledTimes(n + 1)
    }
  )

  it.each([
    { stage: 'claim probe', replies: [] },
    { stage: 'stale claim takeover', replies: ['LOCKED'] },
    { stage: 'owner write', replies: ['LOCKED', 'OK'] },
    { stage: 'release', replies: ['LOCKED', 'OK', ''] }
  ])('stops the claim waiter after an unconfirmed $stage', async ({ replies }) => {
    const error = unconfirmedTermination()
    for (const reply of replies) {
      mockExec.mockResolvedValueOnce(reply)
    }
    mockExec.mockRejectedValueOnce(error)

    await expect(waitForRelayGcClaimRelease(conn, remoteDir, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(replies.length + 1)
  })

  it('preserves claim probe uncertainty when the caller also aborts', async () => {
    const controller = new AbortController()
    const error = unconfirmedTermination()
    mockExec.mockImplementationOnce(async () => {
      controller.abort(new Error('deploy aborted'))
      throw error
    })

    await expect(waitForRelayGcClaimRelease(conn, remoteDir, host, controller.signal)).rejects.toBe(
      error
    )
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('stops when cleanup after a confirmed owner write failure is unconfirmed', async () => {
    const error = unconfirmedTermination()
    mockExec
      .mockResolvedValueOnce('OK')
      .mockRejectedValueOnce(confirmedFailure())
      .mockRejectedValueOnce(error)

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('keeps a confirmed acquisition failure as contention', async () => {
    mockExec.mockRejectedValueOnce(confirmedFailure())

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host)).resolves.toBeNull()
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('conditionally releases after a confirmed owner write failure', async () => {
    mockExec
      .mockResolvedValueOnce('OK')
      .mockRejectedValueOnce(confirmedFailure())
      .mockResolvedValueOnce('RELEASED')

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host)).resolves.toBeNull()
    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('keeps a confirmed ownership probe failure as lost ownership', async () => {
    mockExec.mockRejectedValueOnce(confirmedFailure())

    await expect(isRelayGcClaimOwned(conn, remoteDir, token, host)).resolves.toBe(false)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('retains bounded retries for confirmed release failures', async () => {
    mockExec.mockRejectedValue(confirmedFailure())

    await expect(releaseRelayGcClaimWithRetry(conn, remoteDir, token, host)).resolves.toBe(
      'unknown'
    )
    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('retries confirmed release failures until release succeeds', async () => {
    mockExec.mockRejectedValueOnce(confirmedFailure()).mockResolvedValueOnce('RELEASED')

    await expect(releaseRelayGcClaimWithRetry(conn, remoteDir, token, host)).resolves.toBe(
      'released'
    )
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('still recovers a claim after a confirmed probe failure', async () => {
    mockExec
      .mockRejectedValueOnce(confirmedFailure())
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('RELEASED')

    await expect(waitForRelayGcClaimRelease(conn, remoteDir, host)).resolves.toBeUndefined()
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  it('still polls after a confirmed stale takeover failure', async () => {
    vi.useFakeTimers()
    mockExec
      .mockResolvedValueOnce('LOCKED')
      .mockRejectedValueOnce(confirmedFailure())
      .mockResolvedValueOnce('OPEN')

    const waiting = waitForRelayGcClaimRelease(conn, remoteDir, host)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(waiting).resolves.toBeUndefined()
    expect(mockExec).toHaveBeenCalledTimes(3)
  })
})
