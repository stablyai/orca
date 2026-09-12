import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error && 'sshChannelCloseConfirmed' in error
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('remote orcad activation record reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses a native PowerShell file read on Windows', async () => {
    vi.mocked(execCommand).mockResolvedValue('')

    await readOrcadActivationRecord({
      conn: {} as SshConnection,
      host: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:/Users/orca'
    })

    const command = String(vi.mocked(execCommand).mock.calls[0]?.[1])
    const script = decodePowerShellCommand(command)
    expect(script).toContain('[IO.File]::ReadAllText')
    expect(script).toContain('orcad-active.json')
    expect(script).not.toContain('/dev/null')
  })

  it('does not convert lost host contact into an absent record', async () => {
    vi.mocked(execCommand).mockRejectedValue(new Error('transport lost'))

    await expect(
      readOrcadActivationRecord({
        conn: {} as SshConnection,
        host: getRemoteHostPlatform('linux-x64'),
        remoteHome: '/home/orca'
      })
    ).rejects.toThrow('transport lost')
  })
})

describe('remote orcad activation record writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('promotes a complete POSIX temporary file with one atomic rename', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    await writeOrcadActivationRecord(
      {
        conn: {} as SshConnection,
        host: getRemoteHostPlatform('linux-x64'),
        remoteHome: '/home/orca'
      },
      emptyOrcadActivationRecord()
    )

    const command = String(vi.mocked(execCommand).mock.calls[0]?.[1])
    expect(command).toContain('orcad-active.json.partial.')
    expect(command).toContain('mv -f')
  })

  it('uses File.Replace for an existing Windows activation record', async () => {
    vi.mocked(execCommand).mockResolvedValue('')
    await writeOrcadActivationRecord(
      {
        conn: {} as SshConnection,
        host: getRemoteHostPlatform('win32-x64'),
        remoteHome: 'C:/Users/orca'
      },
      emptyOrcadActivationRecord()
    )

    const script = decodePowerShellCommand(String(vi.mocked(execCommand).mock.calls[0]?.[1]))
    expect(script).toContain('[IO.File]::WriteAllText')
    expect(script).toContain('[IO.File]::Replace')
    expect(script).toContain('[IO.File]::Move')
  })

  it('retains an uncertain temporary write when remote teardown is unconfirmed', async () => {
    const error = Object.assign(new Error('transport lost'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(execCommand).mockRejectedValueOnce(error)

    await expect(
      writeOrcadActivationRecord(
        {
          conn: {} as SshConnection,
          host: getRemoteHostPlatform('linux-x64'),
          remoteHome: '/home/orca'
        },
        emptyOrcadActivationRecord()
      )
    ).rejects.toBe(error)
    expect(execCommand).toHaveBeenCalledTimes(1)
  })
})
