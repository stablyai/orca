import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import {
  getForegroundProcessName,
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

beforeEach(() => {
  execFileMock.mockReset()
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
    mockExecFile((_command, args) => {
      if (args[0] === '-axo') {
        return {
          stdout: ['100 99 Ss   bash -l', '101 100 S+   node /home/dev/.local/bin/codex'].join('\n')
        }
      }
      return new Error('unexpected command')
    })

    await expect(getForegroundProcessName(100, 'node')).resolves.toBe('codex')
  })

  it('recognizes SSH relay wrapped agents when no foreground marker is available', async () => {
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

  it('does not guess when SSH relay wrapper descendants are ambiguous', async () => {
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

  it('does not report a stopped SSH relay agent when another process has foreground', async () => {
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
