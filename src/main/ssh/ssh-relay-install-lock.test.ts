import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  isRelayGcClaimed: vi.fn().mockResolvedValue(false),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'

describe('acquireInstallLock', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('propagates an unconfirmed lock-create termination so deploy can retain the lock fence', async () => {
    const controller = new AbortController()
    const termination = Object.assign(new Error('lock creation termination was not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('.install-lock')) {
        controller.abort(
          Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
        )
        throw termination
      }
      return ''
    })

    await expect(
      acquireInstallLock(
        {} as SshConnection,
        '/home/u/.orca-remote/relay-0.1.0',
        getRemoteHostPlatform('linux-x64'),
        { signal: controller.signal }
      )
    ).rejects.toBe(termination)
  })

  it('does not steal a stale state-transaction fence when takeover is disabled', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.startsWith('mkdir -p')) {
        return ''
      }
      return command.includes('.install-lock') ? 'BUSY' : ''
    })

    const pending = acquireInstallLock(
      {} as SshConnection,
      '/home/u/.orca-remote/.orcad-activation-transaction',
      getRemoteHostPlatform('linux-x64'),
      { signal: controller.signal, allowStaleTakeover: false }
    )
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.mocked(execCommand).mock.calls.map(([, command]) => command)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('lock_tombstone')])
    )
  })
})
