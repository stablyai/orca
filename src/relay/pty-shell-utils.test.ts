import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot'
import {
  getForegroundProcessName,
  isProcessAlive,
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
  execFileMock.mockReset()
  resetProcessTableSnapshotForTests()
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
        (path) => path === 'C:\\Tools\\pwsh.exe'
      )
    ).toBe('C:\\Tools\\pwsh.exe')
  })

  it('prefers inbox PowerShell before ComSpec for an interactive Windows PTY', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe'
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
        (path) => path === 'C:\\Windows\\System32\\cmd.exe'
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
  it('returns clear non-wrapper foregrounds without process-table enrichment', async () => {
    await expect(getForegroundProcessName(100, 'vim')).resolves.toBe('vim')

    expect(execFileMock).not.toHaveBeenCalled()
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
      mockExecFile((command) => {
        if (command === 'powershell.exe') {
          return {
            stdout: JSON.stringify([
              {
                CommandLine: 'powershell.exe',
                ExecutablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                Name: 'powershell.exe',
                ParentProcessId: 99,
                ProcessId: 100
              },
              {
                CommandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
                ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
                Name: 'node.exe',
                ParentProcessId: 100,
                ProcessId: 101
              }
            ])
          }
        }
        return new Error('unexpected command')
      })

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
