import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_WINDOWS_TAR_SHIM_DIR_ENV } from '../../shared/codex-shell-function'
import {
  applyCodexWindowsSystemTarShimEnv,
  ensureCodexWindowsSystemTarShim
} from './codex-windows-system-tar'

const roots: string[] = []
const SYSTEM_ROOT = 'D:\\Windows'
const SYSTEM_TAR = win32.join(SYSTEM_ROOT, 'System32', 'tar.exe')
const SHIM_CONTENT = '@"%SystemRoot%\\System32\\tar.exe" %*\r\n'
const SCOPE_WRAPPER_CONTENT =
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=%~dp0;%PATH%"\r\ncall %*\r\nexit /b %errorlevel%\r\n'

function makeUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-tar-'))
  roots.push(root)
  return root
}

function systemTarExists(path: string): boolean {
  return path === SYSTEM_TAR
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows system tar shim', () => {
  it('writes the forwarding shim and cmd scope wrapper under userData', () => {
    const userDataPath = makeUserData()

    const shimDir = ensureCodexWindowsSystemTarShim(userDataPath, {
      platform: 'win32',
      systemRoot: SYSTEM_ROOT,
      fileExists: systemTarExists
    })

    expect(shimDir).toBe(join(userDataPath, 'shims', 'windows-system-tar'))
    if (!shimDir) {
      throw new Error('Expected the Windows tar shim directory')
    }
    expect(readFileSync(join(shimDir, 'tar.cmd'), 'utf8')).toBe(SHIM_CONTENT)
    expect(readFileSync(join(shimDir, 'codex-tar-scope.cmd'), 'utf8')).toBe(SCOPE_WRAPPER_CONTENT)
    expect(readdirSync(shimDir).toSorted()).toEqual(['codex-tar-scope.cmd', 'tar.cmd'])
  })

  it('does not rewrite an unchanged shim', () => {
    const userDataPath = makeUserData()
    const options = {
      platform: 'win32' as const,
      systemRoot: SYSTEM_ROOT,
      fileExists: systemTarExists
    }
    const shimDir = ensureCodexWindowsSystemTarShim(userDataPath, options)
    if (!shimDir) {
      throw new Error('Expected the Windows tar shim directory')
    }
    const shimPath = join(shimDir, 'tar.cmd')
    const oldTime = new Date('2001-02-03T04:05:06.000Z')
    utimesSync(shimPath, oldTime, oldTime)
    const before = statSync(shimPath).mtimeMs

    expect(ensureCodexWindowsSystemTarShim(userDataPath, options)).toBe(shimDir)
    expect(statSync(shimPath).mtimeMs).toBe(before)
  })

  it('atomically repairs stale shim contents', () => {
    const userDataPath = makeUserData()
    const shimDir = join(userDataPath, 'shims', 'windows-system-tar')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'tar.cmd'), '@echo stale\r\n')

    expect(
      ensureCodexWindowsSystemTarShim(userDataPath, {
        platform: 'win32',
        systemRoot: SYSTEM_ROOT,
        fileExists: systemTarExists
      })
    ).toBe(shimDir)
    expect(readFileSync(join(shimDir, 'tar.cmd'), 'utf8')).toBe(SHIM_CONTENT)
    expect(readFileSync(join(shimDir, 'codex-tar-scope.cmd'), 'utf8')).toBe(SCOPE_WRAPPER_CONTENT)
    expect(readdirSync(shimDir).toSorted()).toEqual(['codex-tar-scope.cmd', 'tar.cmd'])
  })

  it('does nothing off Windows', () => {
    const userDataPath = makeUserData()
    const fileExists = vi.fn(() => true)

    expect(
      ensureCodexWindowsSystemTarShim(userDataPath, { platform: 'linux', fileExists })
    ).toBeNull()
    expect(fileExists).not.toHaveBeenCalled()
    expect(readdirSync(userDataPath)).toEqual([])
  })

  it('warns and inherits PATH when Windows tar is missing', () => {
    const userDataPath = makeUserData()
    const warn = vi.fn()

    expect(
      ensureCodexWindowsSystemTarShim(userDataPath, {
        platform: 'win32',
        systemRoot: SYSTEM_ROOT,
        fileExists: () => false,
        warn
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      `[codex-tar] Windows system tar is unavailable at ${SYSTEM_TAR}; inheriting PATH`
    )
    expect(readdirSync(userDataPath)).toEqual([])
  })

  it('warns and inherits PATH when SystemRoot is unavailable', () => {
    const userDataPath = makeUserData()
    const fileExists = vi.fn(() => true)
    const warn = vi.fn()

    expect(
      ensureCodexWindowsSystemTarShim(userDataPath, {
        platform: 'win32',
        systemRoot: '',
        fileExists,
        warn
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[codex-tar] Windows SystemRoot is unavailable; inheriting PATH'
    )
    expect(fileExists).not.toHaveBeenCalled()
    expect(readdirSync(userDataPath)).toEqual([])
  })

  it('stamps only native Windows system mode and clears stale markers otherwise', () => {
    const userDataPath = makeUserData()
    const base = {
      userDataPath,
      platform: 'win32' as const,
      systemRoot: SYSTEM_ROOT,
      fileExists: systemTarExists
    }
    const env: Record<string, string> = {
      [CODEX_WINDOWS_TAR_SHIM_DIR_ENV]: 'C:\\stale',
      KEEP: '1'
    }

    applyCodexWindowsSystemTarShimEnv(env, { ...base, mode: 'system', isWsl: false })
    expect(env).toEqual({
      [CODEX_WINDOWS_TAR_SHIM_DIR_ENV]: join(userDataPath, 'shims', 'windows-system-tar'),
      KEEP: '1'
    })

    applyCodexWindowsSystemTarShimEnv(env, { ...base, mode: 'inherit', isWsl: false })
    expect(env).toEqual({ KEEP: '1' })
    env.orca_codex_windows_tar_shim_dir = 'C:\\stale'
    applyCodexWindowsSystemTarShimEnv(env, { ...base, mode: 'system', isWsl: true })
    expect(env).toEqual({ KEEP: '1' })
  })
})
