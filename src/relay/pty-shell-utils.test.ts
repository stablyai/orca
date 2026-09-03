import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, getAllProcessesMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getAllProcessesMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

import { resetWindowsProcessRowsSnapshotForTests } from '../main/providers/windows-foreground-process-rows'
import { __setWindowsProcessTreeLoaderForTests } from '../main/windows/windows-process-table'
import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot-reader'
import {
  getForegroundProcessName,
  isProcessAlive,
  processHasChildren,
  resolveDefaultCwd,
  resolveWindowsDefaultShell
} from './pty-shell-utils'

function mockExecFile(
  implementation: (command: string, args: string[]) => { stdout: string; stderr?: string } | Error
): void {
  execFileMock.mockImplementation(
    (command: string, args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      const result = implementation(command, args)
      if (result instanceof Error) {
        callback(result, { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: result.stdout, stderr: result.stderr ?? '' })
    }
  )
}

/**
 * Feed the native Windows snapshot. A real snapshot always contains the
 * querying process, and the reader rejects a table without it.
 */
function mockWindowsProcessTable(
  rows: { pid: number; ppid: number; name: string; commandLine?: string }[]
): void {
  __setWindowsProcessTreeLoaderForTests(() => ({
    ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
    getAllProcesses: (cb: (value: typeof rows | undefined) => void) =>
      cb([{ pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }, ...rows])
  }))
  getAllProcessesMock.mockClear()
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  run: () => T | Promise<T>
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
  resetProcessTableSnapshotForTests()
  resetWindowsProcessRowsSnapshotForTests()
  __setWindowsProcessTreeLoaderForTests()
})

describe('isProcessAlive', () => {
  it('reports the test runner process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('reports a process as dead ONLY on ESRCH', () => {
    // Why: attach() reaps a lingering managed PTY based on this, so a false
    // positive would kill a live remote shell. Only "no such process" counts.
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })
    try {
      expect(isProcessAlive(2147483646)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('treats an unsignalable process (EPERM) as alive', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    try {
      expect(isProcessAlive(1)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveWindowsDefaultShell', () => {
  it('uses an existing SHELL override when one is provided', () => {
    expect(
      resolveWindowsDefaultShell(
        {
          SHELL: 'C:\\Tools\\pwsh.exe',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === 'C:\\Tools\\pwsh.exe',
        () => {
          throw new Error('DefaultShell should not be read when SHELL wins')
        }
      )
    ).toBe('C:\\Tools\\pwsh.exe')
  })

  it('uses an existing OpenSSH DefaultShell path', () => {
    const powershell7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell7,
        () => powershell7
      )
    ).toBe(powershell7)
  })

  it('reads and memoizes the OpenSSH DefaultShell registry value', async () => {
    execFileSyncMock.mockReturnValue(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe'
      ].join('\n')
    )

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')

    expect(readOpenSshDefaultShell()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(readOpenSshDefaultShell()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    )
  })

  it('treats malformed OpenSSH DefaultShell output as empty and preserves the fallback chain', async () => {
    execFileSyncMock.mockReturnValue(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShellCommandOption    REG_SZ    /c'
      ].join('\n')
    )

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(readOpenSshDefaultShell()).toBe('')
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        readOpenSshDefaultShell
      )
    ).toBe(powershell)
  })

  it('treats reg.exe failures as empty and preserves the fallback chain', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('reg.exe failed')
    })

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(readOpenSshDefaultShell()).toBe('')
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        readOpenSshDefaultShell
      )
    ).toBe(powershell)
  })

  it('preserves the fallback chain for an invalid OpenSSH DefaultShell', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell,
        () => 'C:\\missing\\pwsh.exe'
      )
    ).toBe(powershell)
  })

  it('honors a deliberate OpenSSH PowerShell 5.1 DefaultShell value', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell,
        () => powershell
      )
    ).toBe(powershell)
  })

  it('prefers inbox PowerShell before ComSpec for an interactive Windows PTY', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        () => ''
      )
    ).toBe(powershell)
  })

  it('falls back to ComSpec when PowerShell cannot be found by path', () => {
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === 'C:\\Windows\\System32\\cmd.exe',
        () => ''
      )
    ).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('resolveDefaultCwd', () => {
  it('uses USERPROFILE for Windows PTYs without an explicit cwd', () => {
    expect(
      resolveDefaultCwd(
        {
          USERPROFILE: 'C:\\Users\\alice',
          HOME: '/not/a/windows/cwd'
        },
        'win32',
        'C:\\Users\\fallback'
      )
    ).toBe('C:\\Users\\alice')
  })

  it('falls back to HOMEDRIVE plus HOMEPATH on Windows when USERPROFILE is missing', () => {
    expect(
      resolveDefaultCwd(
        {
          HOMEDRIVE: 'D:',
          HOMEPATH: '\\Users\\bob'
        },
        'win32',
        'C:\\Users\\fallback'
      )
    ).toBe('D:\\Users\\bob')
  })

  it('keeps POSIX HOME fallback behavior', () => {
    expect(resolveDefaultCwd({ HOME: '/home/alice' }, 'linux', '/fallback')).toBe('/home/alice')
  })
})

describe('getForegroundProcessName', () => {
  it('keeps a non-agent foreground name when the process table shows no agent', async () => {
    await withProcessPlatform('darwin', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: ['100 99 Ss   zsh -l', '101 100 S+   vim notes.md'].join('\n') }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'vim')).resolves.toBe('vim')
    })
  })

  it('resolves a macOS p_comm basename to the agent that owns the foreground', async () => {
    // Why: node-pty reports the native Claude binary as its version directory (`2.1.258`);
    // answering with that name downgrades agent prompts to unframed chunks (STA-4577).
    await withProcessPlatform('darwin', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: ['100 99 Ss   zsh -l', '101 100 S+   claude --model haiku'].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, '2.1.258')).resolves.toBe('claude')
    })
  })

  it('recognizes SSH relay node-wrapped agents from descendant command lines', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: ['100 99 Ss   bash -l', '101 100 S+   node /home/dev/.local/bin/codex'].join(
              '\n'
            )
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'node')).resolves.toBe('codex')
    })
  })

  it('recognizes Windows SSH relay shell-rooted agent descendants', async () => {
    await withProcessPlatform('win32', async () => {
      mockWindowsProcessTable([
        { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
        {
          pid: 101,
          ppid: 100,
          name: 'node.exe',
          commandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
        }
      ])

      await expect(getForegroundProcessName(100, 'powershell.exe')).resolves.toBe('codex')
    })
  })

  it('recognizes SSH relay wrapped agents when no foreground marker is available', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: [
              '100 99 Ss   bash -l',
              '101 100 S    node /home/dev/.local/bin/node_modules/@google/gemini-cli/bundle/gemini.mjs'
            ].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'node')).resolves.toBe('gemini')
    })
  })

  it('does not guess when SSH relay wrapper descendants are ambiguous', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: [
              '100 99 Ss   bash -l',
              '101 100 S    node /home/dev/project/server.js',
              '102 100 S    node /home/dev/.local/bin/node_modules/@openai/codex/bin/codex.js'
            ].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'node')).resolves.toBe('node')
    })
  })

  it('does not report a stopped SSH relay agent when another process has foreground', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: [
              '100 99 Ss   bash -l',
              '101 100 T    node /home/dev/.local/bin/codex',
              '102 100 S+   vim notes.txt'
            ].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'node')).resolves.toBe('node')
    })
  })

  // Why: OMP embeds Pi, but the outer process is the user-visible identity (#6364).
  it('reports the outer omp wrapper over the wrapped pi child from a shell fallback', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: ['100 99 Ss   bash -l', '101 100 S+   omp', '102 101 S+   pi'].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'bash')).resolves.toBe('omp')
    })
  })

  it('rescans for the omp wrapper when node-pty reports the wrapped pi as foreground', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: ['100 99 Ss   bash -l', '101 100 S+   omp', '102 101 S+   pi'].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'pi')).resolves.toBe('omp')
    })
  })

  it('returns an outer omp fallback without a process-table scan', async () => {
    mockExecFile(() => new Error('unexpected process-table scan'))

    await expect(getForegroundProcessName(100, 'omp')).resolves.toBe('omp')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rescans a Windows pi fallback for its outer omp wrapper', async () => {
    await withProcessPlatform('win32', async () => {
      mockWindowsProcessTable([
        { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
        { pid: 101, ppid: 100, name: 'omp.exe', commandLine: 'omp.exe' },
        { pid: 102, ppid: 101, name: 'pi.exe', commandLine: 'pi.exe' }
      ])

      await expect(getForegroundProcessName(100, 'pi')).resolves.toBe('omp')
    })
  })

  it('keeps a pi fallback as pi when no omp wrapper is in the tree', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: ['100 99 Ss   bash -l', '101 100 S+   pi'].join('\n') }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'pi')).resolves.toBe('pi')
    })
  })

  it('normalizes a wrapper fallback the process table cannot confirm', async () => {
    // Why: the table scan must answer null, not the raw node-pty name, so the
    // ladder still publishes the RECOGNIZED (normalized) identity.
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: ['100 99 Ss   bash -l', '101 100 S+   vim notes.txt'].join('\n') }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, '/opt/homebrew/bin/pi')).resolves.toBe('pi')
    })
  })

  it('resolves a duplicated root pid to the FIRST capture row', async () => {
    // Preserve rows.find() semantics if a malformed table repeats a pid: an argv
    // newline makes `ps` print a continuation line that can parse as a spurious
    // row, so the real root (row one) must keep owning the pane's foreground.
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return {
            stdout: ['100 1 Ss bash', '100 1 Ss+ bash', '101 100 S node /opt/codex'].join('\n')
          }
        }
        return new Error('unexpected command')
      })

      await expect(getForegroundProcessName(100, 'bash')).resolves.toBe('codex')
    })
  })

  it('falls back to the root process command when descendant inspection fails', async () => {
    mockExecFile((_command, args) => {
      if (args[0] === '-axo') {
        return new Error('ps table unavailable')
      }
      return { stdout: 'bash\n' }
    })

    await expect(getForegroundProcessName(100)).resolves.toBe('bash')
  })
})

describe('processHasChildren', () => {
  // Why these assert on argv, not just the answer: the defect in #13537 was the
  // cost of the answer. `pgrep -P` forks per pane per poll and opens six procfs
  // files per host process to resolve one ppid, so the contract worth pinning is
  // "no fork of its own, and share the foreground lookup's cached table".
  const PS_TABLE = ['100 1 Ss bash', '101 100 S+ node /opt/codex', '200 1 Ss zsh'].join('\n')

  it('answers from the shared process table without forking pgrep', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: PS_TABLE }
        }
        return new Error('unexpected command')
      })

      await expect(processHasChildren(100)).resolves.toBe(true)
      await expect(processHasChildren(200)).resolves.toBe(false)

      expect(execFileMock.mock.calls.map((call) => call[0])).not.toContain('pgrep')
    })
  })

  it('shares one process-table capture across a burst of panes', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: PS_TABLE }
        }
        return new Error('unexpected command')
      })

      const answers = await Promise.all([
        processHasChildren(100),
        processHasChildren(100),
        processHasChildren(200),
        getForegroundProcessName(100, 'bash')
      ])

      expect(answers).toEqual([true, true, false, 'codex'])
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })
  })

  it('rescans for a close decision rather than serving a table from inside the TTL', async () => {
    await withProcessPlatform('linux', async () => {
      let table = PS_TABLE
      mockExecFile((_command, args) => {
        if (args[0] === '-axo') {
          return { stdout: table }
        }
        return new Error('unexpected command')
      })

      // The poll answers from the cache, which is the whole point of the memo.
      await expect(processHasChildren(200)).resolves.toBe(false)
      table = [PS_TABLE, '201 200 S+ npm run build'].join('\n')
      await expect(processHasChildren(200)).resolves.toBe(false)
      expect(execFileMock).toHaveBeenCalledTimes(1)

      // A close or cleanup acts on the answer once and destructively, so a
      // child started inside the 500ms window has to be visible to it.
      await expect(processHasChildren(200, { fresh: true })).resolves.toBe(true)
      expect(execFileMock).toHaveBeenCalledTimes(2)
    })
  })

  it('reports no children when the process table is unreadable', async () => {
    await withProcessPlatform('linux', async () => {
      mockExecFile(() => new Error('ps table unavailable'))

      await expect(processHasChildren(100)).resolves.toBe(false)
    })
  })

  it('spawns nothing on Windows, where the answer was always false', async () => {
    await withProcessPlatform('win32', async () => {
      await expect(processHasChildren(100)).resolves.toBe(false)

      expect(execFileMock).not.toHaveBeenCalled()
    })
  })
})
