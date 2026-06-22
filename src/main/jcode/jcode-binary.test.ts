import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveJcodeBinForEnvironment } from './jcode-binary'

function makeFileCheck(existingFiles: readonly string[]): (candidate: string) => boolean {
  const files = new Set(existingFiles)
  return (candidate) => files.has(candidate)
}

describe('resolveJcodeBinForEnvironment', () => {
  it('prefers ORCA_JCODE_BIN when it points at an existing file', () => {
    const envPath = '/tmp/orca-jcode-env/jcode'
    const shellPath = '/opt/orca-jcode-shell/jcode'
    const execFileSyncMock = vi.fn(() => `${shellPath}\n`)

    expect(
      resolveJcodeBinForEnvironment({
        env: { ORCA_JCODE_BIN: envPath, SHELL: '/bin/zsh' },
        homeDir: '/home/orca-test',
        execFileSync: execFileSyncMock,
        isExistingFile: makeFileCheck([envPath, shellPath])
      })
    ).toBe(envPath)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('prefers a login-shell command -v result when it is an existing absolute path', () => {
    const shellPath = '/opt/orca-jcode-shell/jcode'
    const cargoPath = path.posix.join('/home/orca-test', '.cargo', 'bin', 'jcode')
    const execFileSyncMock = vi.fn(() => `jcode is ${shellPath}\n${shellPath}\n`)

    expect(
      resolveJcodeBinForEnvironment({
        env: { SHELL: '/bin/zsh' },
        platform: 'linux',
        homeDir: '/home/orca-test',
        execFileSync: execFileSyncMock,
        isExistingFile: makeFileCheck([shellPath, cargoPath])
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
          isExistingFile: makeFileCheck([cargoPath])
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
        isExistingFile: makeFileCheck([])
      })
    ).toBe('jcode')
  })
})
