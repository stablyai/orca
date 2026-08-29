import { beforeEach, describe, expect, it, vi } from 'vitest'
import { windowsProcessTreeRelaySha256 } from '../../shared/windows-process-tree-relay-manifest'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isRelayAlreadyInstalled, isRemoteInstallComplete } from './ssh-relay-versioned-install'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

describe('Windows relay install integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['x64', 'arm64'] as const)(
    'accepts a complete %s relay only when its addon hash matches',
    async (arch) => {
      const windows = getRemoteHostPlatform(`win32-${arch}`)
      mockExec.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK')

      await expect(isRelayAlreadyInstalled(conn, 'C:/relay', windows)).resolves.toBe(true)

      expect(mockExec).toHaveBeenCalledTimes(2)
      const hashScript = decodePowerShellCommand(mockExec.mock.calls[1]?.[1] ?? '')
      expect(hashScript).toContain('Get-FileHash')
      expect(hashScript).toContain('windows-process-tree.node')
      expect(hashScript).toContain(windowsProcessTreeRelaySha256(arch))
    }
  )

  it('rejects a complete relay whose present addon has the wrong hash', async () => {
    const windows = getRemoteHostPlatform('win32-x64')
    mockExec.mockResolvedValueOnce('OK').mockResolvedValueOnce('MISMATCH')

    await expect(isRelayAlreadyInstalled(conn, 'C:/relay', windows)).resolves.toBe(false)
  })

  it('does not apply the relay addon integrity probe to orcad installs', async () => {
    const windows = getRemoteHostPlatform('win32-x64')
    mockExec.mockResolvedValueOnce('OK')

    await expect(
      isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, 'C:/orcad', windows)
    ).resolves.toBe(true)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })
})
