import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

const getAllProcessesMock = vi.fn()

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  confirmShellForegroundProcess,
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'

describe('agent foreground confirmation', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    getAllProcessesMock.mockReset()
    resetProcessTableSnapshotForTests()
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  function mockPs(stdout: string): void {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout, stderr: '' })
      }
    )
  }

  it('treats a fresh POSIX snapshot missing the PTY root as unavailable', async () => {
    mockPs('101 999 S+ node /Users/dev/.nvm/versions/node/bin/codex')

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
  })

  it('fresh-confirms Codex from its PTY when a whole-host scan would time out', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (args[0] === '-p') {
        callback(null, {
          stdout: '100 99 100 101 S ttys060 Fri Sep 4 15:53:34 2026 -/bin/zsh -l\n',
          stderr: ''
        })
        return
      }
      if (args[0] === '-t') {
        callback(null, {
          stdout: [
            '100 99 100 101 S ttys060 Fri Sep 4 15:53:34 2026 -/bin/zsh -l',
            '101 100 101 101 S+ ttys060 Fri Sep 4 15:53:35 2026 node /opt/homebrew/bin/codex',
            '102 101 101 101 S+ ttys060 Fri Sep 4 15:53:35 2026 /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex'
          ].join('\n'),
          stderr: ''
        })
        return
      }
      callback(new Error('whole-host ps timed out'), { stdout: '', stderr: '' })
    })

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: true, processName: 'codex' })
    expect(execFileMock.mock.calls.map((call) => call[1]?.[0])).toEqual(['-p', '-t'])
  })

  it('rejects a PTY capture when its root process changes between samples', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      callback(null, {
        stdout:
          args[0] === '-p'
            ? '100 99 100 101 S ttys060 Fri Sep 4 15:53:34 2026 -/bin/zsh -l\n'
            : [
                '100 99 100 101 S ttys060 Fri Sep 4 15:53:35 2026 -/bin/zsh -l',
                '101 100 101 101 S+ ttys060 Fri Sep 4 15:53:35 2026 codex'
              ].join('\n'),
        stderr: ''
      })
    })

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
    expect(execFileMock.mock.calls.map((call) => call[1]?.[0])).toEqual(['-p', '-t'])
  })

  it('rejects a malformed row in a PTY-scoped confirmation capture', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      callback(null, {
        stdout:
          args[0] === '-p'
            ? '100 99 100 101 S ttys060 Fri Sep 4 15:53:34 2026 -/bin/zsh -l\n'
            : [
                '100 99 100 101 S ttys060 Fri Sep 4 15:53:34 2026 -/bin/zsh -l',
                'malformed foreground row',
                '101 100 101 101 S+ ttys060 Fri Sep 4 15:53:35 2026 codex'
              ].join('\n'),
        stderr: ''
      })
    })

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
  })

  it('treats failed POSIX scans as unavailable', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
    await expect(resolveAgentForegroundProcessWithAvailability(100, 'zsh')).resolves.toEqual({
      available: false,
      processName: 'zsh'
    })
    await expect(resolveAgentForegroundProcess(100, 'zsh')).resolves.toBe('zsh')
  })

  it('confirms a quoted login shell only when its fresh PTY tree contains shells', async () => {
    mockPs(['100 99 Ss+  "/bin/zsh" -l', '101 100 S+   /bin/bash'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(true)
  })

  it('uses spawned-shell identity instead of a lagging foreground child label', async () => {
    mockPs(['100 99 Ss+  /bin/zsh -l'].join('\n'))

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('confirms the spawned shell behind a login wrapper while prompt hooks run', async () => {
    mockPs(
      [
        '100 99 Ss   /usr/bin/login -pfl developer /bin/zsh',
        '101 100 S+   -zsh',
        '102 101 S+   (zsh)',
        '103 102 S+   (sed)',
        '104 102 R+   (git)'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('rejects a foreground nested shell while the spawned shell remains suspended', async () => {
    mockPs(
      [
        '100 99 Ss   /usr/bin/login -pfl developer /bin/zsh',
        '101 100 S    -zsh',
        '102 101 S+   agent-tui',
        '103 102 S+   /bin/zsh -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a TUI and its nested shell remain in the PTY tree', async () => {
    mockPs(
      [
        '100 99 Ss   /bin/zsh -l',
        '101 100 S+   /usr/local/bin/agent-tui',
        '102 101 S+   /bin/bash -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a stopped TUI remains resumable', async () => {
    mockPs(['100 99 Ss+  /bin/zsh -l', '101 100 T    /usr/local/bin/agent-tui'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('refuses WSL shells: wsl.exe is not a provable shell identity', async () => {
    // Why pinned: the WSL job object holds only wsl.exe, so a looser
    // isShellProcess would confirm ownership regardless of distro-side state.
    await expect(confirmShellForegroundProcess(100, 'wsl.exe')).resolves.toBe(false)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails open when fresh shell ownership inspection is unavailable', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('confirms a Windows shell from fresh root-only ConPTY membership', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const readWindowsPtyJobProcessIds = vi.fn(async () => new Set([100]))

    await expect(
      confirmShellForegroundProcess(100, 'powershell.exe', { readWindowsPtyJobProcessIds })
    ).resolves.toBe(true)
    expect(getAllProcessesMock).not.toHaveBeenCalled()
  })

  it('rejects Windows shell ownership with a child or unavailable membership', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await expect(
      confirmShellForegroundProcess(100, 'powershell.exe', {
        readWindowsPtyJobProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toBe(false)
    await expect(
      confirmShellForegroundProcess(100, 'powershell.exe', {
        readWindowsPtyJobProcessIds: async () => null
      })
    ).resolves.toBe(false)
  })

  it('does not report Claude print-mode hook descendants as foreground agents', async () => {
    mockPs(
      [
        '100 99 Ss   bash -i',
        '101 100 S+   claude --print --model haiku Analyze this conversation and determine next work'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('does not report a stopped agent after the shell regains foreground', async () => {
    mockPs(
      ['100 99 Ss+  bash -i', '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('falls back to recognized descendants when no process in the PTY tree holds foreground', async () => {
    // No '+' marker at all (e.g. a detached/daemon descendant tree) — the
    // recognized agent may still be the best available signal.
    mockPs(
      ['100 99 Ss   bash -i', '101 100 S    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })
})
