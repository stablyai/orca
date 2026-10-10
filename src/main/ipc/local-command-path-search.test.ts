import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listLocalCommandPaths, resolveLocalExecutionCommand } from './command-path-resolver'

const { stat, access } = vi.hoisted(() => ({ stat: vi.fn(), access: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat, access, constants: { X_OK: 1 } }))

beforeEach(() => {
  vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined)
  access.mockResolvedValue(undefined)
  stat.mockImplementation(async (file: string) => {
    if (file === '/workspace' || file === 'C:\\workspace') {
      return { isDirectory: () => true, isFile: () => false }
    }
    throw Object.assign(new Error('absent'), { code: 'ENOENT' })
  })
})
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

describe('execution command resolution', () => {
  it('anchors relative PATH entries and direct command paths in the child directory', async () => {
    stat.mockImplementation(async (file: string) => ({
      isDirectory: () => file === '/workspace',
      isFile: () => file === '/workspace/bin/codex'
    }))
    const options = { platform: 'linux' as const, cwd: '/workspace', env: { PATH: 'bin' } }
    expect(await resolveLocalExecutionCommand('codex', options)).toEqual({
      status: 'resolved',
      program: '/workspace/bin/codex'
    })
    expect(await resolveLocalExecutionCommand('./bin/codex', options)).toEqual({
      status: 'resolved',
      program: '/workspace/bin/codex'
    })
    expect(await listLocalCommandPaths('codex', options)).toEqual([])
  })

  it('proves absence only after inspecting the child search path', async () => {
    expect(
      await resolveLocalExecutionCommand('codex', {
        platform: 'linux',
        cwd: '/workspace',
        env: { PATH: 'bin:/other' }
      })
    ).toEqual({ status: 'missing' })
    expect(stat.mock.calls.map(([file]) => file)).toEqual([
      '/workspace',
      '/workspace/bin/codex',
      '/other/codex'
    ])
  })

  it.each(['EACCES', 'EIO', 'ENOTDIR', 'ELOOP'])(
    'does not turn an unreadable candidate into missing: %s',
    async (code) => {
      stat.mockImplementation(async (file: string) => {
        if (file === '/workspace') {
          return { isDirectory: () => true }
        }
        throw Object.assign(new Error('unverifiable'), { code })
      })
      expect(
        await resolveLocalExecutionCommand('codex', {
          platform: 'linux',
          cwd: '/workspace',
          env: { PATH: 'bin:/later' }
        })
      ).toEqual({ status: 'unknown' })
      expect(stat).not.toHaveBeenCalledWith('/later/codex')
    }
  )

  it('withholds absence when the child directory cannot be read', async () => {
    expect(
      await resolveLocalExecutionCommand('codex', {
        platform: 'linux',
        cwd: '/missing',
        env: { PATH: '/other' }
      })
    ).toEqual({ status: 'unknown' })
  })

  it('uses the native default PATH when a supplied POSIX environment omits it', async () => {
    await resolveLocalExecutionCommand('codex', { platform: 'linux', cwd: '/workspace', env: {} })
    expect(stat.mock.calls.map(([file]) => file)).toEqual([
      '/workspace',
      '/usr/bin/codex',
      '/bin/codex'
    ])
  })

  it('keeps an explicitly empty POSIX PATH tied to the child directory', async () => {
    await resolveLocalExecutionCommand('codex', {
      platform: 'linux',
      cwd: '/workspace',
      env: { PATH: '' }
    })
    expect(stat.mock.calls.map(([file]) => file)).toEqual(['/workspace', '/workspace/codex'])
  })

  it.each(['"C:\\tools"', 'D:tools', 'D:'])(
    'withholds absence for an ambiguous Windows PATH: %s',
    async (PATH) => {
      expect(
        await resolveLocalExecutionCommand('codex', {
          platform: 'win32',
          cwd: 'C:\\workspace',
          env: { PATH }
        })
      ).toEqual({ status: 'unknown' })
    }
  )

  it('honors native Windows current-directory search suppression', async () => {
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '1')
    await resolveLocalExecutionCommand('codex', {
      platform: 'win32',
      cwd: 'C:\\workspace',
      env: { PATH: 'C:\\tools' }
    })
    expect(stat).not.toHaveBeenCalledWith('C:\\workspace\\codex.exe')
    expect(stat).toHaveBeenCalledWith('C:\\tools\\codex.exe')
  })

  it('does not restore suppressed Windows current-directory lookup through empty PATH entries', async () => {
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '1')
    await resolveLocalExecutionCommand('codex', {
      platform: 'win32',
      cwd: 'C:\\workspace',
      env: { PATH: ';C:\\tools;' }
    })
    expect(stat).not.toHaveBeenCalledWith('C:\\workspace\\codex.exe')
    expect(stat).toHaveBeenCalledWith('C:\\tools\\codex.exe')
  })

  it('resolves a Windows codex.cmd from relative PATH for the shared shim boundary', async () => {
    stat.mockImplementation(async (file: string) => {
      if (file === 'C:\\workspace' || file === 'C:\\workspace\\bin\\codex.cmd') {
        return { isDirectory: () => file === 'C:\\workspace', isFile: () => file.endsWith('.cmd') }
      }
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    expect(
      await resolveLocalExecutionCommand('codex.cmd', {
        platform: 'win32',
        cwd: 'C:\\workspace',
        env: { Path: 'bin' }
      })
    ).toEqual({ status: 'resolved', program: 'C:\\workspace\\bin\\codex.cmd' })
  })

  it('does not substitute a PATHEXT batch file for a bare native Windows executable', async () => {
    await resolveLocalExecutionCommand('codex', {
      platform: 'win32',
      cwd: 'C:\\workspace',
      env: { PATH: 'bin', PATHEXT: '.CMD' }
    })
    expect(stat).toHaveBeenCalledWith('C:\\workspace\\bin\\codex.exe')
    expect(stat).not.toHaveBeenCalledWith('C:\\workspace\\bin\\codex.CMD')
  })
})
