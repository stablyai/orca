import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveJcodeBinForEnvironment } from './jcode-binary'

function makeRunnableCheck(runnableFiles: readonly string[]): (candidate: string) => boolean {
  const files = new Set(runnableFiles)
  return (candidate) => files.has(candidate)
}

describe('resolveJcodeBinForEnvironment', () => {
  it('prefers ORCA_JCODE_BIN when it points at a runnable file', () => {
    const envPath = '/tmp/orca-jcode-env/jcode'
    const shellPath = '/opt/orca-jcode-shell/jcode'
    const execFileSyncMock = vi.fn(() => `${shellPath}\n`)

    expect(
      resolveJcodeBinForEnvironment({
        env: { ORCA_JCODE_BIN: envPath, SHELL: '/bin/zsh' },
        homeDir: '/home/orca-test',
        execFileSync: execFileSyncMock,
        isRunnableFile: makeRunnableCheck([envPath, shellPath])
      })
    ).toBe(envPath)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'skips a POSIX env override file that exists but is not executable',
    () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'orca-jcode-bin-'))
      try {
        const candidate = path.join(tempDir, 'jcode')
        writeFileSync(candidate, '#!/bin/sh\n')
        chmodSync(candidate, 0o600)

        expect(
          resolveJcodeBinForEnvironment({
            env: { ORCA_JCODE_BIN: candidate },
            platform: 'linux',
            homeDir: path.join(tempDir, 'home'),
            execFileSync: vi.fn(() => {
              throw new Error('not found')
            })
          })
        ).toBe('jcode')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  )

  it('prefers a login-shell command -v result when it is a runnable absolute path', () => {
    const shellPath = '/opt/orca-jcode-shell/jcode'
    const cargoPath = path.posix.join('/home/orca-test', '.cargo', 'bin', 'jcode')
    const execFileSyncMock = vi.fn(() => `jcode is ${shellPath}\n${shellPath}\n`)

    expect(
      resolveJcodeBinForEnvironment({
        env: { SHELL: '/bin/zsh' },
        platform: 'linux',
        homeDir: '/home/orca-test',
        execFileSync: execFileSyncMock,
        isRunnableFile: makeRunnableCheck([shellPath, cargoPath])
      })
    ).toBe(shellPath)
    expect(execFileSyncMock).toHaveBeenCalledWith('/bin/zsh', ['-lc', 'command -v jcode'], {
      encoding: 'utf8',
      timeout: 5000
    })
  })

  it.each([
    {
      platform: 'linux' as const,
      homeDir: '/home/orca-test',
      cargoPath: path.posix.join('/home/orca-test', '.cargo', 'bin', 'jcode')
    },
    {
      platform: 'win32' as const,
      homeDir: 'C:\\Users\\OrcaTest',
      cargoPath: path.win32.join('C:\\Users\\OrcaTest', '.cargo', 'bin', 'jcode.exe')
    }
  ])(
    'falls back to the platform cargo bin on $platform without a hardcoded user path',
    ({ platform, homeDir, cargoPath }) => {
      expect(
        resolveJcodeBinForEnvironment({
          env: {},
          platform,
          homeDir,
          execFileSync: vi.fn(() => {
            throw new Error('not found')
          }),
          isRunnableFile: makeRunnableCheck([cargoPath])
        })
      ).toBe(cargoPath)
      expect(cargoPath).toContain(homeDir)
    }
  )

  it('returns bare jcode when no configured, shell, or cargo candidate exists', () => {
    expect(
      resolveJcodeBinForEnvironment({
        env: {},
        platform: 'linux',
        homeDir: '/home/orca-test',
        execFileSync: vi.fn(() => {
          throw new Error('not found')
        }),
        isRunnableFile: makeRunnableCheck([])
      })
    ).toBe('jcode')
  })

  it('skips a non-runnable POSIX env override and uses the runnable shell result', () => {
    const envPath = '/tmp/orca-jcode-env/not-runnable'
    const shellPath = '/opt/orca-jcode-shell/jcode'

    expect(
      resolveJcodeBinForEnvironment({
        env: { ORCA_JCODE_BIN: envPath, SHELL: '/bin/zsh' },
        platform: 'linux',
        homeDir: '/home/orca-test',
        execFileSync: vi.fn(() => `${shellPath}\n`),
        isRunnableFile: makeRunnableCheck([shellPath])
      })
    ).toBe(shellPath)
  })

  it('returns bare jcode when the POSIX cargo candidate is not runnable', () => {
    expect(
      resolveJcodeBinForEnvironment({
        env: {},
        platform: 'linux',
        homeDir: '/home/orca-test',
        execFileSync: vi.fn(() => {
          throw new Error('not found')
        }),
        isRunnableFile: makeRunnableCheck([])
      })
    ).toBe('jcode')
  })
})
