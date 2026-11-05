import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  isRelayGcClaimOwned,
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim
} from './remote-install-gc-claim'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedSshConnection } from '../../ssh/unused-host-transport.test-fixture'

const conn = unusedSshConnection()
const mockExec = vi.mocked(execCommand)
const token = 'claim-owner'

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

  it('keeps a confirmed acquisition failure as contention', async () => {
    mockExec.mockRejectedValueOnce(confirmedFailure())

    await expect(tryAcquireRelayGcClaim(conn, remoteDir, host)).resolves.toBeNull()
    expect(mockExec).toHaveBeenCalledTimes(1)
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
})
