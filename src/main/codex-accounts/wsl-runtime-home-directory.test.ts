import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeChildProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  statSync: vi.fn()
}))
const execMock = vi.hoisted(() => ({ execFileSync: vi.fn() }))
const actualFs = vi.hoisted(() => ({
  mkdirSync: undefined as undefined | NodeFs['mkdirSync'],
  statSync: undefined as undefined | NodeFs['statSync']
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  actualFs.mkdirSync = actual.mkdirSync
  actualFs.statSync = actual.statSync
  fsMock.mkdirSync.mockImplementation(actual.mkdirSync)
  fsMock.statSync.mockImplementation(actual.statSync)
  return { ...actual, mkdirSync: fsMock.mkdirSync, statSync: fsMock.statSync }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  execMock.execFileSync.mockImplementation(actual.execFileSync)
  return { ...actual, execFileSync: execMock.execFileSync }
})

import { ensureWslRuntimeHomeDirectory } from './wsl-runtime-home-directory'

describe('ensureWslRuntimeHomeDirectory', () => {
  let dir: string | undefined

  beforeEach(() => {
    fsMock.mkdirSync.mockImplementation(actualFs.mkdirSync!)
    fsMock.statSync.mockImplementation(actualFs.statSync!)
    execMock.execFileSync.mockReset()
  })

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('returns when the path is already a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-runtime-home-'))
    fsMock.mkdirSync.mockClear()
    ensureWslRuntimeHomeDirectory(dir)
    expect(fsMock.mkdirSync).not.toHaveBeenCalled()
    expect(execMock.execFileSync).not.toHaveBeenCalled()
  })

  it('creates a missing directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-runtime-home-'))
    const target = join(dir, 'codex-runtime-home', 'home')
    ensureWslRuntimeHomeDirectory(target)
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(target, { recursive: true })
    expect(execMock.execFileSync).not.toHaveBeenCalled()
  })

  it('treats EISDIR as success when a later stat sees a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-runtime-home-'))
    const error = Object.assign(new Error('EISDIR: illegal operation on a directory, mkdir'), {
      code: 'EISDIR'
    })
    fsMock.statSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      .mockImplementationOnce(() => ({ isDirectory: () => true }) as NodeFs.Stats)
    fsMock.mkdirSync.mockImplementation(() => {
      throw error
    })
    expect(() => ensureWslRuntimeHomeDirectory(dir as string)).not.toThrow()
    expect(execMock.execFileSync).not.toHaveBeenCalled()
  })

  it('creates a WSL UNC home via wsl.exe when host mkdir throws EISDIR', () => {
    const unc =
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    const error = Object.assign(new Error('EISDIR: illegal operation on a directory, mkdir'), {
      code: 'EISDIR'
    })
    fsMock.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    fsMock.mkdirSync.mockImplementation(() => {
      throw error
    })
    execMock.execFileSync.mockReturnValue(Buffer.from(''))

    ensureWslRuntimeHomeDirectory(unc)

    expect(execMock.execFileSync).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu-24.04',
        '--exec',
        'mkdir',
        '-p',
        '--',
        '/home/alice/.local/share/orca/codex-runtime-home/home'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }
    )
  })

  it('rethrows when mkdir fails on a non-UNC path that is not a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-runtime-home-'))
    const target = join(dir, 'not-a-dir')
    writeFileSync(target, 'file')
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    fsMock.mkdirSync.mockImplementation(() => {
      throw error
    })
    expect(() => ensureWslRuntimeHomeDirectory(target)).toThrow(error)
    expect(execMock.execFileSync).not.toHaveBeenCalled()
  })
})
