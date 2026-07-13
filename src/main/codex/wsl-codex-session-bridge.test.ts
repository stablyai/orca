import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import {
  buildWslCodexSessionBridgeShellCommand,
  resolveWslCodexSessionBridgeLinuxPaths,
  startWslCodexSessionBridgeInBackground,
  syncWslCodexSessionsIntoManagedHome
} from './wsl-codex-session-bridge'

function mockExecFileSuccess(stdout = '{"scannedFiles":2,"linkedFiles":1}\n'): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ): ChildProcess => {
      callback(null, stdout, '')
      return {} as ChildProcess
    }
  )
}

beforeEach(() => {
  execFileMock.mockReset()
})

describe('syncWslCodexSessionsIntoManagedHome', () => {
  it('runs a WSL hardlink bridge from the WSL system sessions into the managed home', async () => {
    mockExecFileSuccess()

    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 2, linkedFiles: 1 })
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const firstCall = execFileMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [command, args, options] = firstCall as [
      string,
      string[],
      { timeout?: number; windowsHide?: boolean }
    ]
    expect(command).toBe('wsl.exe')
    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc'])
    expect(args).toHaveLength(6)
    expect(options.timeout).toBe(30_000)
    expect(options.windowsHide).toBe(true)

    const shellCommand = args[5]
    expect(shellCommand).toContain("source_sessions_root='/home/alice/.codex/sessions'")
    expect(shellCommand).toContain(
      "managed_sessions_root='/home/alice/.local/share/orca/codex-runtime-home/home/sessions'"
    )
    expect(shellCommand).toContain(`find "\\$source_sessions_root" -type f -name '*.jsonl' -print0`)
    expect(shellCommand).toContain('ln -- "\\$source_file" "\\$target_file"')
    expect(shellCommand).toContain('if [ -e "\\$target_file" ] || [ -L "\\$target_file" ]; then')
    expect(shellCommand).not.toContain('ln -s')
    expect(shellCommand).not.toContain('cp ')
    expect(shellCommand).not.toContain('sqlite')
  })

  it('does not invoke WSL when paths are not resolvable inside the distro', async () => {
    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: 'C:\\Users\\alice\\.codex',
      managedCodexHomePath: 'C:\\Users\\alice\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('parses the summary after WSL profile stdout', async () => {
    mockExecFileSuccess('Welcome to Ubuntu\nprofile output\n{"scannedFiles":4,"linkedFiles":3}\n')

    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 4, linkedFiles: 3 })
  })

  it('coalesces duplicate background bridges for the same WSL target', async () => {
    mockExecFileSuccess()
    const target = {
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    }

    const firstTask = startWslCodexSessionBridgeInBackground(target)
    const secondTask = startWslCodexSessionBridgeInBackground(target)

    expect(firstTask).toBe(secondTask)
    await firstTask
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveWslCodexSessionBridgeLinuxPaths', () => {
  it('requires both homes to belong to the requested distro', () => {
    expect(
      resolveWslCodexSessionBridgeLinuxPaths({
        distro: 'Ubuntu',
        systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
        managedCodexHomePath:
          '\\\\wsl.localhost\\Debian\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
      })
    ).toBeNull()
  })

  it('accepts Linux paths for direct script construction tests', () => {
    expect(
      resolveWslCodexSessionBridgeLinuxPaths({
        distro: 'Ubuntu',
        systemCodexHomePath: '/home/alice/.codex',
        managedCodexHomePath: '/home/alice/.local/share/orca/codex-runtime-home/home'
      })
    ).toEqual({
      systemSessionsRoot: '/home/alice/.codex/sessions',
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })
  })
})

describe('buildWslCodexSessionBridgeShellCommand', () => {
  it('only targets JSONL session files under sessions', () => {
    const shellCommand = buildWslCodexSessionBridgeShellCommand({
      systemSessionsRoot: "/home/alice/.codex/sessions with 'quote'",
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })

    expect(shellCommand).toContain(
      `source_sessions_root='/home/alice/.codex/sessions with '\\''quote'\\'''`
    )
    expect(shellCommand).toContain(`-name '*.jsonl'`)
    expect(shellCommand).not.toContain('.sqlite')
  })

  it('escapes Linux-side shell variable expansion for wsl.exe argv', () => {
    const shellCommand = buildWslCodexSessionBridgeShellCommand({
      systemSessionsRoot: '/home/alice/.codex/sessions',
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })

    expect(shellCommand).toContain('\\$source_sessions_root')
    expect(shellCommand).toContain('\\$source_file')
    expect(shellCommand).toContain('\\$((scanned_files + 1))')
  })
})
