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
})
