import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodePath from 'node:path'

const { realpath, open, handle } = vi.hoisted(() => {
  const stats = { size: 5, dev: 1, ino: 1, nlink: 1, isFile: () => true }
  const handle = {
    stat: vi.fn(async () => stats),
    close: vi.fn(async () => {}),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const bytes = Buffer.from('IMAGE')
      const bytesRead = Math.min(length, bytes.length - position)
      bytes.copy(target, offset, position, position + bytesRead)
      return { bytesRead, buffer: target }
    })
  }
  return {
    realpath: vi.fn(async (path: string) => path),
    open: vi.fn(async () => handle),
    handle
  }
})

// The real containment guard must use Windows path semantics in these simulated cases.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return {
    ...actual,
    relative: (from: string, to: string) =>
      (process.platform === 'win32' ? actual.win32 : actual.posix).relative(from, to),
    isAbsolute: (path: string) =>
      (process.platform === 'win32' ? actual.win32 : actual.posix).isAbsolute(path),
    get sep() {
      return process.platform === 'win32' ? actual.win32.sep : actual.posix.sep
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    realpath,
    open,
    lstat: async () => ({ size: 5, dev: 1, ino: 1, nlink: 1, isFile: () => true })
  }
})

import { readTerminalKittyFile } from './terminal-kitty-file-read'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  realpath.mockImplementation(async (path: string) => path)
})
afterEach(() => vi.unstubAllGlobals())

const OWNER = { workspacePath: 'C:\\repo', wslDistro: 'Ubuntu' }
const ROOT = '\\\\wsl.localhost\\Ubuntu'

describe('authoritative WSL Kitty file roots', () => {
  it('allows guest /tmp for a WSL PTY with a native Windows workspace', async () => {
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, OWNER)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(open).toHaveBeenCalledWith(`${ROOT}\\tmp\\claude-image`, expect.any(Number))
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('allows only guest temporary roots for a floating WSL terminal', async () => {
    const owner = { workspacePath: null, wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, owner)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(open).toHaveBeenCalledWith(`${ROOT}\\tmp\\claude-image`, expect.any(Number))
    await expect(readTerminalKittyFile({ path: '/mnt/c/repo/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(realpath).not.toHaveBeenCalledWith(null)
  })

  it('uses the native path for the guest Windows drive mount', async () => {
    await expect(readTerminalKittyFile({ path: '/mnt/c/repo/image' }, OWNER)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(realpath).toHaveBeenCalledWith('C:\\repo')
    expect(open).toHaveBeenCalledWith('C:\\repo\\image', expect.any(Number))
  })

  it('maps a POSIX workspace to the native drive path', async () => {
    const owner = { workspacePath: '/mnt/c/repo', wslDistro: 'Ubuntu' }
    realpath.mockImplementation(async (path: string) => {
      if (path === owner.workspacePath) {
        throw new Error('Native Windows cannot resolve this Linux path')
      }
      return path
    })
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, owner)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(realpath).toHaveBeenCalledWith('C:\\repo')
    expect(realpath).not.toHaveBeenCalledWith(owner.workspacePath)
  })

  it('canonicalizes native short names for guest drive-mount images', async () => {
    const workspacePath = 'C:\\Users\\RUNNER~1\\repo'
    realpath.mockImplementation(async (path: string) => {
      if (path === workspacePath) {
        return 'C:\\Users\\runneradmin\\repo'
      }
      if (path.includes('RUNNER~1')) {
        throw new Error('ENOENT')
      }
      return path
    })
    const owner = { workspacePath, wslDistro: 'Ubuntu' }
    for (const path of ['/tmp/claude-image', '/mnt/c/Users/runneradmin/repo/image']) {
      await expect(readTerminalKittyFile({ path }, owner)).resolves.toEqual({
        base64: 'SU1BR0U='
      })
    }
    expect(realpath).toHaveBeenCalledWith(workspacePath)
    expect(realpath).not.toHaveBeenCalledWith(`${ROOT}\\mnt\\c\\Users\\RUNNER~1\\repo`)
  })

  it('avoids the WSL1 UNC drive mount while allowing guest temporary files', async () => {
    realpath.mockImplementation(async (path: string) => {
      if (path.startsWith(`${ROOT}\\mnt\\c`)) {
        throw new Error('EPERM: operation not permitted, realpath')
      }
      return path
    })
    for (const path of ['/tmp/claude-image', '/mnt/c/repo/image']) {
      await expect(readTerminalKittyFile({ path }, OWNER)).resolves.toEqual({
        base64: 'SU1BR0U='
      })
    }
    expect(realpath).not.toHaveBeenCalledWith(`${ROOT}\\mnt\\c\\repo`)
  })

  it('uses the PTY distro rather than an old workspace UNC distro', async () => {
    const owner = { workspacePath: '\\\\wsl.localhost\\Debian\\repo', wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, owner)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(realpath).toHaveBeenCalledWith(`${ROOT}\\repo`)
    expect(realpath).not.toHaveBeenCalledWith(owner.workspacePath)
    expect(open).toHaveBeenCalledWith(`${ROOT}\\tmp\\claude-image`, expect.any(Number))
  })

  it('does not fold distinct canonical directory names on a Windows drive mount', async () => {
    await expect(readTerminalKittyFile({ path: '/mnt/c/Repo/private.png' }, OWNER)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('allows drive-letter case differences without folding directory names', async () => {
    const owner = { workspacePath: 'c:\\repo', wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/mnt/c/repo/image' }, owner)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
  })

  it('does not fold case in a WSL Linux directory name', async () => {
    const owner = { workspacePath: `${ROOT}\\repo`, wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/Repo/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fold equivalent Unicode names into a WSL root', async () => {
    const owner = { workspacePath: `${ROOT}\\é`, wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/e\u0301/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('does not authorize a distinct Unicode sibling of a native root', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const owner = { workspacePath: '/srv/é', wslDistro: null }
    await expect(readTerminalKittyFile({ path: '/srv/e\u0301/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a canonical target in a different distro before opening', async () => {
    realpath.mockImplementation(async (path: string) =>
      path.endsWith('claude-image') ? '\\\\wsl.localhost\\Debian\\tmp\\claude-image' : path
    )
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, OWNER)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })
})
