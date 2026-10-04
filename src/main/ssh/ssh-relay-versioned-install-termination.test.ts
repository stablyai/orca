import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

import type { SshConnection } from './ssh-connection'
import { REMOTE_INSTALL_MODELS } from './remote-install-model'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './ssh-relay-versioned-install'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked execCommand never reads the connection.
const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)

beforeEach(() => {
  mockExec.mockReset()
})

describe.each([
  { platform: 'linux-x64' as const, remoteDir: '/relay/version' },
  { platform: 'win32-x64' as const, remoteDir: 'C:/relay/version' }
])('install-complete probe termination on $platform', ({ platform, remoteDir }) => {
  const host = getRemoteHostPlatform(platform)

  it.each([abandonInstall, finalizeInstall])(
    'preserves uncertainty from lock release by %s',
    async (release) => {
      const error = Object.assign(new Error('release still running'), {
        sshChannelCloseConfirmed: false
      })
      mockExec.mockResolvedValue('')
      if (release === finalizeInstall) {
        mockExec.mockResolvedValueOnce('')
      }
      mockExec.mockRejectedValueOnce(error)
      await expect(release(conn, remoteDir, host)).rejects.toBe(error)
    }
  )

  it.each([abandonInstall, finalizeInstall])(
    'keeps confirmed release failures nonfatal in %s',
    async (release) => {
      if (release === finalizeInstall) {
        mockExec.mockResolvedValueOnce('')
      }
      mockExec.mockRejectedValueOnce(
        Object.assign(new Error('release failed'), {
          sshChannelCloseConfirmed: true
        })
      )
      await expect(release(conn, remoteDir, host)).resolves.toBeUndefined()
    }
  )

  describe.each(REMOTE_INSTALL_MODELS)('$id installs', (model) => {
    it.each([
      { aborted: false, rethrowSessionLimitErrors: false },
      { aborted: false, rethrowSessionLimitErrors: true },
      { aborted: true, rethrowSessionLimitErrors: false },
      { aborted: true, rethrowSessionLimitErrors: true }
    ])(
      'preserves uncertainty with aborted=$aborted and strict=$rethrowSessionLimitErrors',
      async ({ aborted, rethrowSessionLimitErrors }) => {
        const controller = new AbortController()
        const error = Object.assign(new Error('SSH teardown not confirmed'), {
          sshChannelCloseConfirmed: false
        })
        mockExec.mockImplementationOnce(async () => {
          if (aborted) {
            controller.abort(new Error('deploy aborted'))
          }
          throw error
        })

        await expect(
          isRemoteInstallComplete(conn, model, remoteDir, host, {
            signal: controller.signal,
            rethrowSessionLimitErrors
          })
        ).rejects.toBe(error)
        expect(mockExec).toHaveBeenCalledTimes(1)
      }
    )

    it('keeps a confirmed command failure as an incomplete install', async () => {
      mockExec.mockRejectedValueOnce(
        Object.assign(new Error('SSH command failed after closing'), {
          sshChannelCloseConfirmed: true
        })
      )

      await expect(isRemoteInstallComplete(conn, model, remoteDir, host)).resolves.toBe(false)
    })

    it('keeps caller cancellation after a confirmed command failure', async () => {
      const controller = new AbortController()
      const abortError = new Error('deploy aborted')
      mockExec.mockImplementationOnce(async () => {
        controller.abort(abortError)
        throw Object.assign(new Error('SSH command failed after closing'), {
          sshChannelCloseConfirmed: true
        })
      })

      await expect(
        isRemoteInstallComplete(conn, model, remoteDir, host, { signal: controller.signal })
      ).rejects.toBe(abortError)
    })
  })
})
