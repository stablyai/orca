import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { tryDeleteWslUncPath } from './wsl-unc-delete'

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
    execFileMock.mockReset()
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, '', '')
    })
  })

  it('returns false and never spawns for a normal local path', async () => {
    await withPlatform('win32', async () => {
      await expect(tryDeleteWslUncPath('C:\\Users\\me\\repo\\file.txt')).resolves.toBe(false)
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns false off Windows so non-Windows callers keep trashing', async () => {
    await withPlatform('darwin', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).resolves.toBe(false)
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('hard-deletes a WSL UNC file via rm inside the distro', async () => {
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).resolves.toBe(true)
    })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [binary, spawnArgs] = execFileMock.mock.calls[0]
    expect(binary).toBe('wsl.exe')
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

    const [, spawnArgs] = execFileMock.mock.calls[0]
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

    const [, spawnArgs] = execFileMock.mock.calls[0]
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
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('Command failed'), '', 'ORCA_WSL_DELETE_REJECT:inspection')
    })

    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault\\session.json', {
          approvedRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\vault']
        })
      ).rejects.toMatchObject({ reason: 'path-outside-known-roots' })
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a target without a same-distro containing root before spawning', async () => {
    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\vault\\session.json', {
          approvedRoots: ['\\\\wsl.localhost\\Debian\\home\\me\\vault']
        })
      ).rejects.toMatchObject({ reason: 'path-outside-known-roots' })
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('also handles the legacy \\\\wsl$ UNC prefix', async () => {
    await withPlatform('win32', async () => {
      await tryDeleteWslUncPath('\\\\wsl$\\Debian\\srv\\app.log')
    })

    const [, spawnArgs] = execFileMock.mock.calls[0]
    expect(spawnArgs).toEqual(['-d', 'Debian', '--exec', 'rm', '-f', '--', '/srv/app.log'])
  })

  it('surfaces the distro stderr when rm fails', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('Command failed'), '', 'rm: cannot remove: Permission denied')
    })

    await withPlatform('win32', async () => {
      await expect(
        tryDeleteWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\file.txt')
      ).rejects.toThrow('Failed to delete WSL path: rm: cannot remove: Permission denied')
    })
  })
})
