import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock, wokenMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  wokenMock: vi.fn((_distro: string) => {})
}))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('./wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  noteWslDistroWoken: wokenMock
}))
vi.mock('./wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

function exited(code: number, stderr = ''): ProcessResult {
  return { code, signal: null, stdout: '', stderr, timedOut: false }
}

import { tryDeleteWslUncPath } from './wsl-unc-delete'
import { isWslUserActFor } from './wsl/wsl-user-act-scope'

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('tryDeleteWslUncPath', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(exited(0))
  })

  it('returns false and never spawns for a normal local path', async () => {
    await withPlatform('win32', async () => {
      await expect(tryDeleteWslUncPath('C:\\Users\\me\\repo\\file.txt')).resolves.toBe(false)
    })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('returns false off Windows so non-Windows callers keep trashing', async () => {
    await withPlatform('darwin', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).resolves.toBe(false)
    })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('hard-deletes a WSL UNC file via rm inside the distro', async () => {
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).resolves.toBe(true)
    })

    expect(runProcessMock).toHaveBeenCalledTimes(1)
    const [{ program, args: spawnArgs, cwd, timeoutMs }] = runProcessMock.mock.calls[0]
    expect(program).toBe('wsl.exe')
    expect(timeoutMs).toBe(30000)
    expect(cwd).toEqual('C:\\Windows')
    expect(spawnArgs).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      'rm',
      '-f',
      '--',
      '/home/me/repo/file.txt'
    ])
  })

  it('passes -rf for a recursive directory delete', async () => {
    await withPlatform('win32', async () => {
      await tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\dir', {
        recursive: true
      })
    })

    const [{ args: spawnArgs }] = runProcessMock.mock.calls[0]
    expect(spawnArgs).toEqual(['-d', 'Ubuntu', '--exec', 'rm', '-rf', '--', '/home/me/repo/dir'])
  })

  it('runs approved-root deletion through the contained command', async () => {
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault\\real\\session', {
          recursive: true,
          approvedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\vault']
        })
      ).resolves.toBe(true)
    })

    const [{ args: spawnArgs }] = runProcessMock.mock.calls[0]
    expect(spawnArgs.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c'])
    expect(spawnArgs.slice(-7)).toEqual([
      'directory',
      '3',
      'home',
      'me',
      'vault',
      'real',
      'session'
    ])
  })

  it('rejects an inspection failure instead of falling back to direct rm', async () => {
    runProcessMock.mockResolvedValue(exited(65, 'ORCA_WSL_DELETE_REJECT:inspection'))

    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault\\session.json', {
          approvedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\vault']
        })
      ).rejects.toMatchObject({ reason: 'path-outside-known-roots' })
    })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a target without a same-distro containing root before spawning', async () => {
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault\\session.json', {
          approvedRoots: ['\\\\wsl.localhost\\Debian\\home\\me\\vault']
        })
      ).rejects.toMatchObject({ reason: 'path-outside-known-roots' })
    })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('also handles the legacy \\\\wsl$ UNC prefix', async () => {
    await withPlatform('win32', async () => {
      await tryDeleteWslUncPath('\\\\wsl$\\Debian\\srv\\app.log')
    })

    const [{ args: spawnArgs }] = runProcessMock.mock.calls[0]
    expect(spawnArgs).toEqual(['-d', 'Debian', '--exec', 'rm', '-f', '--', '/srv/app.log'])
  })

  it('surfaces the distro stderr when rm fails', async () => {
    runProcessMock.mockResolvedValue(exited(1, 'rm: cannot remove: Permission denied'))

    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).rejects.toThrow('Failed to delete WSL path: rm: cannot remove: Permission denied')
    })
  })

  // A user's delete may start a stopped distro; background readers must then stop trusting "stopped".
  it('runs the delete as a user act on its distro and notes it woken', async () => {
    let insideAct = false
    runProcessMock.mockImplementation(async () => {
      insideAct = isWslUserActFor('Ubuntu')
      return exited(0)
    })
    wokenMock.mockClear()
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\old.jsonl')
      ).resolves.toBe(true)
    })
    expect(insideAct).toBe(true)
    expect(wokenMock).toHaveBeenCalledWith('Ubuntu')
  })
})
