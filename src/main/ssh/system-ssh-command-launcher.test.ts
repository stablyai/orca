import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, existsSync: existsSyncMock }
})

vi.mock('child_process', () => ({ spawn: spawnMock }))

import { spawnSystemSshCommand } from './system-ssh-command'

function createTarget(): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy'
  }
}

function createChildProcess(): EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 12345
  child.kill = vi.fn()
  return child
}

describe('system SSH Windows no-input launcher selection', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockReset()
    spawnMock.mockReturnValue(createChildProcess())
  })

  it('uses an explicitly supplied Windows launcher without OpenSSH null input', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const launcherPath = 'C:\\fixture\\orca-ssh-no-input-launcher.exe'
    const windowsSshPath = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    const previousSystemSshPath = process.env.ORCA_SYSTEM_SSH_PATH
    process.env.ORCA_SYSTEM_SSH_PATH = windowsSshPath
    let channel: ReturnType<typeof spawnSystemSshCommand>
    try {
      channel = spawnSystemSshCommand(createTarget(), 'echo ready', {
        noInput: true,
        windowsNoInputLauncherPath: launcherPath
      })
    } finally {
      platform.mockRestore()
      if (previousSystemSshPath === undefined) {
        delete process.env.ORCA_SYSTEM_SSH_PATH
      } else {
        process.env.ORCA_SYSTEM_SSH_PATH = previousSystemSshPath
      }
    }

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(spawnMock).toHaveBeenCalledWith(
      launcherPath,
      expect.arrayContaining([
        windowsSshPath,
        '--',
        'deploy@example.com',
        "exec /bin/sh -c 'echo ready'"
      ]),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
    expect(args).not.toContain('-n')
    expect(channel._systemSshLaunchMode).toBe('windows-no-input-launcher')
  })

  it('ignores a supplied launcher on POSIX and preserves OpenSSH no-input handling', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    let channel: ReturnType<typeof spawnSystemSshCommand>
    try {
      channel = spawnSystemSshCommand(createTarget(), 'echo ready', {
        noInput: true,
        windowsNoInputLauncherPath: '/tmp/not-a-posix-launcher'
      })
    } finally {
      platform.mockRestore()
    }

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
      expect.arrayContaining(['-n', '--', 'deploy@example.com']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
    expect(channel._systemSshLaunchMode).toBe('direct')
  })
})
