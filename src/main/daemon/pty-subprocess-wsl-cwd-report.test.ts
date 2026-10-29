import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../pwsh', () => ({ isPwshAvailable: isPwshAvailableMock }))
vi.mock('../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  resolveUnixShellPath: resolveUnixShellPathMock,
  validateWorkingDirectory: validateWorkingDirectoryMock,
  validateWorkingDirectoryAsync: validateWorkingDirectoryMock
}))
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

// The daemon's bridge spawn must point the guest at the wrappers that carry the folder report,
// not the daemon's own Unix fileset (daemon-shell-ready-wrapper-fileset.ts).
describe('a daemon-spawned WSL bridge pane', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('sources wrappers that report its folder', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await createPtySubprocess({
        sessionId: 'test',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const [file, args, options] = spawnMock.mock.calls.at(-1)!
    expect(file).toBe('wsl.exe')
    expect(args.at(-1)).toContain('"${_orca_shell_ready_root}/bash/rcfile"')
    expect(args.at(-1)).toContain('ZDOTDIR="${_orca_shell_ready_root}/zsh"')
    const root: string = options.env.ORCA_SHELL_READY_ROOT
    expect(options.env.WSLENV.split(':')).toContain('ORCA_SHELL_READY_ROOT/p')
    expect(readFileSync(join(root, 'bash', 'rcfile'), 'utf8')).toContain('__orca_wsl_cwd_report')
    expect(readFileSync(join(root, 'zsh', '.zshenv'), 'utf8')).toContain('__orca_wsl_cwd_report')
  })
})
