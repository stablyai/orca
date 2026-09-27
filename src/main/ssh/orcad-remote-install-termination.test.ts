import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: vi.fn(),
  writeRelayFile: vi.fn()
}))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import { installOrcadBundle } from './orcad-remote-install'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All connection operations are mocked.
const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)
const mockUpload = vi.mocked(uploadRelayDirectory)
const mockWrite = vi.mocked(writeRelayFile)
const fullVersion = '0.2.0+abcdef123456'

function issuedCommands(): string[] {
  return mockExec.mock.calls.map(([, command]) => decodeRemotePowerShellScript(command))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockReset().mockResolvedValue('')
  mockUpload.mockReset().mockResolvedValue(undefined)
  mockWrite.mockReset().mockResolvedValue(undefined)
})

describe.each([
  { platform: 'linux-x64' as const, remoteDir: '/home/u/.orca-remote/orcad-version' },
  { platform: 'win32-x64' as const, remoteDir: 'C:/Users/u/.orca-remote/orcad-version' }
])('orcad install termination on $platform', ({ platform, remoteDir }) => {
  const host = getRemoteHostPlatform(platform)
  const completionCommandNumber = host.os === 'win32' ? 3 : 4
  const stages = [
    { stage: 'locked recheck', commands: 2 },
    { stage: 'upload', commands: 2 },
    { stage: 'version write', commands: completionCommandNumber - 1 },
    { stage: 'completion marker', commands: completionCommandNumber }
  ]
  const install = (signal?: AbortSignal): Promise<void> =>
    installOrcadBundle(
      { conn, host, localOrcadDir: '/local/orcad', signal },
      fullVersion,
      remoteDir
    )

  function failStage(stage: string, commandNumber: number, error: Error): void {
    if (stage === 'upload') {
      mockUpload.mockRejectedValueOnce(error)
    } else if (stage === 'version write') {
      mockWrite.mockRejectedValueOnce(error)
    } else {
      let calls = 0
      mockExec.mockImplementation(async () => {
        if (++calls === commandNumber) {
          throw error
        }
        return ''
      })
    }
  }

  it.each(stages)('retains its lock after unconfirmed $stage', async ({ stage, commands }) => {
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    failStage(stage, commands, error)

    await expect(install()).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(commands)
    expect(mockUpload).toHaveBeenCalledTimes(stage === 'locked recheck' ? 0 : 1)
    expect(mockWrite).toHaveBeenCalledTimes(
      stage === 'locked recheck' || stage === 'upload' ? 0 : 1
    )
    expect(issuedCommands().some((command) => command.includes('.install-lock'))).toBe(false)
  })

  it.each(stages)(
    'still releases its lock after confirmed $stage failure',
    async ({ stage, commands }) => {
      const error = Object.assign(new Error('SSH command failed after closing'), {
        sshChannelCloseConfirmed: true
      })
      failStage(stage, commands, error)

      if (stage === 'locked recheck') {
        await expect(install()).resolves.toBeUndefined()
        expect(mockExec).toHaveBeenCalledTimes(completionCommandNumber + 1)
      } else {
        await expect(install()).rejects.toBe(error)
        expect(mockExec).toHaveBeenCalledTimes(commands + 1)
      }
      expect(issuedCommands().at(-1)).toContain('.install-lock')
    }
  )

  it('releases its lock once after successful completion', async () => {
    await expect(install()).resolves.toBeUndefined()

    expect(mockExec).toHaveBeenCalledTimes(completionCommandNumber + 1)
    expect(issuedCommands()[completionCommandNumber - 1]).toContain('.install-complete')
    expect(issuedCommands().at(-1)).toContain('.install-lock')
    expect(mockUpload).toHaveBeenCalledOnce()
    expect(mockWrite).toHaveBeenCalledOnce()
  })

  it('preserves an uncertain locked recheck when the caller also aborts', async () => {
    const controller = new AbortController()
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    mockExec.mockResolvedValueOnce('').mockImplementationOnce(async () => {
      controller.abort(new Error('deploy aborted'))
      throw error
    })

    await expect(install(controller.signal)).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('propagates an uncertain final lock release without retrying it', async () => {
    const error = Object.assign(new Error('SSH teardown not confirmed'), {
      sshChannelCloseConfirmed: false
    })
    failStage('release', completionCommandNumber + 1, error)

    await expect(install()).rejects.toBe(error)
    expect(mockExec).toHaveBeenCalledTimes(completionCommandNumber + 1)
    expect(issuedCommands().at(-1)).toContain('.install-lock')
  })

  it.skipIf(host.os === 'win32')(
    'retains its lock after unconfirmed executable permissions',
    async () => {
      const error = Object.assign(new Error('SSH teardown not confirmed'), {
        sshChannelCloseConfirmed: false
      })
      failStage('permissions', 3, error)

      await expect(install()).rejects.toBe(error)
      expect(mockExec).toHaveBeenCalledTimes(3)
      expect(issuedCommands().at(-1)).toContain('chmod')
      expect(mockWrite).not.toHaveBeenCalled()
    }
  )
})
