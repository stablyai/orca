import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import {
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'
import { resetWindowsProcessRowsSnapshotForTests } from './windows-foreground-process-rows'

// Why: the module wraps execFile with promisify, so the mock must honor the
// Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

function windowsProcessJsonRows(
  rows: {
    CommandLine: string | null
    Name: string
    ParentProcessId: number
    ProcessId: number
    ExecutablePath?: string | null
  }[] = [
    {
      CommandLine: 'powershell.exe',
      Name: 'powershell.exe',
      ParentProcessId: 99,
      ProcessId: 100
    },
    {
      CommandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
      Name: 'node.exe',
      ParentProcessId: 100,
      ProcessId: 101
    }
  ]
): string {
  return JSON.stringify(
    rows.map((row) => ({
      ExecutablePath: row.ExecutablePath ?? null,
      ...row
    }))
  )
}

function windowsProcessValueRows(): string {
  return [
    'CommandLine=powershell.exe',
    'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'Name=powershell.exe',
    'ParentProcessId=99',
    'ProcessId=100',
    '',
    'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
    'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
    'Name=node.exe',
    'ParentProcessId=100',
    'ProcessId=101',
    ''
  ].join('\r\n')
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    // Why: the Windows rows reader caches across calls (500ms TTL), so each
    // case's execFile mock must not be answered by the previous case's rows.
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not report a suspended agent when a non-agent holds the foreground', async () => {
    // shell pid 100. vim (pid 102) holds the terminal foreground ('+'); a
    // suspended codex (pid 101, stat 'T', no '+') is a backgrounded descendant.
    mockPs(
      [
        '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex',
        '102 100 S+   vim notes.txt'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'vim')).resolves.toBe('vim')
  })

  it('still reports a foreground agent', async () => {
    mockPs(['101 100 S+   node /Users/dev/.nvm/versions/node/bin/codex'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })

  // Why: OMP embeds Pi, but the outer process is the user-visible identity (#6364).
  it('reports the outer omp wrapper, not the wrapped pi child', async () => {
    mockPs(['101 100 S+   omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports omp even when the wrapped pi child holds the foreground alone', async () => {
    // Why: across command boundaries only the deeper `pi` carries `+`; the
    // wrapper identity must stay omp regardless of which frame we sampled.
    mockPs(['101 100 S    omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports bare pi when no omp wrapper is present', async () => {
    mockPs(['101 100 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'pi')).resolves.toBe('pi')
  })

  it('reports the outer omp wrapper on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'powershell.exe',
              Name: 'powershell.exe',
              ParentProcessId: 99,
              ProcessId: 100
            },
            {
              CommandLine: 'omp.exe',
              Name: 'omp.exe',
              ParentProcessId: 100,
              ProcessId: 101
            },
            {
              CommandLine: 'pi.exe',
              Name: 'pi.exe',
              ParentProcessId: 101,
              ProcessId: 102
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'pi.exe')).resolves.toBe('omp')
  })

  it('keeps the Windows omp ancestor when context selects one of multiple pi descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'omp.exe',
          Name: 'omp.exe',
          ParentProcessId: 100,
          ProcessId: 101
        },
        {
          CommandLine: 'pi.exe --cwd C:\\repo\\orca',
          Name: 'pi.exe',
          ParentProcessId: 101,
          ProcessId: 102
        },
        {
          CommandLine: 'pi.exe --cwd C:\\repo\\other',
          Name: 'pi.exe',
          ParentProcessId: 100,
          ProcessId: 103
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcess(100, 'pi.exe', { contextPaths: ['C:\\repo\\orca'] })
    ).resolves.toBe('omp')
  })

  it('treats a fresh POSIX snapshot missing the PTY root as unavailable', async () => {
    mockPs('101 999 S+ node /Users/dev/.nvm/versions/node/bin/codex')

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

  it('recognizes Windows wrapper-launched agents from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout: windowsProcessJsonRows(), stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('recognizes Windows shell-rooted agent launches from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, { stdout: windowsProcessJsonRows(), stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('recognizes Windows Git Bash shell-rooted agent launches', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'C:\\Program Files\\Git\\bin\\bash.exe --login -i',
              Name: 'bash.exe',
              ParentProcessId: 99,
              ProcessId: 100
            },
            {
              CommandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
              Name: 'node.exe',
              ParentProcessId: 100,
              ProcessId: 101
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'bash.exe')).resolves.toBe('codex')
  })

  it('keeps multiline Windows command lines inside the parsed process row', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'powershell.exe',
              Name: 'powershell.exe',
              ParentProcessId: 99,
              ProcessId: 100
            },
            {
              CommandLine: [
                'node',
                'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
                '--prompt',
                '"line one\r\nName=gemini.exe\r\nProcessId=999"'
              ].join(' '),
              Name: 'node.exe',
              ParentProcessId: 100,
              ProcessId: 101
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('falls back to WMIC when Windows PowerShell process enumeration fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: windowsProcessValueRows(), stderr: '' })
    })

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'wmic',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('falls back to WMIC when Windows PowerShell returns no process rows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(null, { stdout: '   \r\n', stderr: '' })
        return
      }
      callback(null, { stdout: windowsProcessValueRows(), stderr: '' })
    })

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
    expect(execFileMock).toHaveBeenCalledWith(
      'wmic',
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })

  it('distinguishes unavailable Windows enumeration from a confirmed shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('enumeration unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it.each([
    ['blank', '   \r\n'],
    ['unparseable', 'wmic returned no structured process values']
  ])('treats successful but %s WMIC output as unavailable', async (_label, wmicOutput) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      if (cmd === 'powershell.exe') {
        callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: wmicOutput, stderr: '' })
    })

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('treats an observed Windows shell with no children as authoritative', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'powershell.exe',
              Name: 'powershell.exe',
              ParentProcessId: 99,
              ProcessId: 100
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not restore a recognized fallback that disappeared before confirmation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'droid', {
        fresh: true,
        forceProcessScan: true
      })
    ).resolves.toEqual({ available: true, processName: null })
  })

  it('treats a Windows snapshot missing the requested shell as unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: windowsProcessJsonRows([
            {
              CommandLine: 'unrelated.exe',
              Name: 'unrelated.exe',
              ParentProcessId: 99,
              ProcessId: 200
            }
          ]),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('does not use unrelated Windows agent descendants for wrapper fallbacks', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=codex',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('fails closed for ambiguous Windows shell-rooted agent descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('filters detached agents before resolving an otherwise ambiguous ConPTY tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        },
        {
          CommandLine: 'agy',
          Name: 'agy.exe',
          ParentProcessId: 100,
          ProcessId: 102
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({ available: true, processName: 'droid' })
  })

  it('recognizes a Windows shell-rooted agent when only one candidate matches the worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs --cwd C:\\repo\\other',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Program Files\\nodejs\\node.exe',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('codex')
  })

  it('recognizes the deepest Windows shell-rooted agent when candidates share one lineage', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=codex --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=gemini --cwd C:\\repo\\orca',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
            'Name=gemini.exe',
            'ParentProcessId=101',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('gemini')
  })

  it('fails closed for sibling Windows agents that both match the same worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'CreationDate=20260616110000.000000-000',
            'ExecutablePath=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=codex --cwd C:\\repo\\orca',
            'CreationDate=20260616110100.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
            'Name=codex.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=gemini --cwd C:\\repo\\orca',
            'CreationDate=20260616110200.000000-000',
            'ExecutablePath=C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
            'Name=gemini.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('powershell.exe')
  })

  it('fails closed when Windows has multiple matching wrapper descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(null, {
          stdout: [
            'CommandLine=powershell.exe',
            'Name=powershell.exe',
            'ParentProcessId=99',
            'ProcessId=100',
            '',
            'CommandLine=node C:\\repo\\server.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=101',
            '',
            'CommandLine=node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
            'Name=node.exe',
            'ParentProcessId=100',
            'ProcessId=102',
            ''
          ].join('\r\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('does not enrich Windows foregrounds that are not interpreter wrappers', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await expect(resolveAgentForegroundProcess(100, 'vim.exe')).resolves.toBe('vim.exe')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('authorizes a fresh Windows agent only when it still belongs to the ConPTY', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        }
      ])
    )
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 101, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'droid' })
    expect(readWindowsConptyProcessIds).toHaveBeenCalledTimes(1)
  })

  it('excludes a detached Windows Droid descendant from byte authority', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        },
        {
          CommandLine: 'droid',
          Name: 'droid.exe',
          ParentProcessId: 100,
          ProcessId: 101
        }
      ])
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 999])
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not fork the ConPTY membership helper when no Windows agent is inferred', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockPs(
      windowsProcessJsonRows([
        {
          CommandLine: 'powershell.exe',
          Name: 'powershell.exe',
          ParentProcessId: 99,
          ProcessId: 100
        }
      ])
    )
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
    expect(readWindowsConptyProcessIds).not.toHaveBeenCalled()
  })
})
