import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

const getAllProcessesMock = vi.fn()

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'
// A real snapshot always contains the process doing the querying; the reader
// rejects a table without it, because that is what a blocked
// CreateToolhelp32Snapshot looks like (an empty list, not an error).
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

// Why: the POSIX reader wraps execFile with promisify, so the mock must honor
// the Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

type NativeProcessRow = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
}

const DEFAULT_WINDOWS_ROWS: NativeProcessRow[] = [
  {
    pid: 100,
    ppid: 99,
    name: 'powershell.exe',
    commandLine: 'powershell.exe'
  },
  {
    pid: 101,
    ppid: 100,
    name: 'node.exe',
    commandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
  }
]

function mockWindowsRows(rows: NativeProcessRow[] = DEFAULT_WINDOWS_ROWS): void {
  getAllProcessesMock.mockImplementation((cb: (snapshot: NativeProcessRow[]) => void) => {
    cb(withSelf(rows))
  })
}

/** `undefined` rows are how the native snapshot reports a table it cannot read. */
function mockUnreadableWindowsTable(): void {
  getAllProcessesMock.mockImplementation((cb: (snapshot: undefined) => void) => {
    cb(undefined)
  })
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    getAllProcessesMock.mockReset()
    resetProcessTableSnapshotForTests()
    // Why: the Windows rows reader caches across calls (500ms TTL), so each
    // case's rows must not be answered by the previous case's snapshot.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
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
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'omp.exe',
        commandLine: 'omp.exe'
      },
      {
        pid: 102,
        ppid: 101,
        name: 'pi.exe',
        commandLine: 'pi.exe'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'pi.exe')).resolves.toBe('omp')
  })

  it('keeps the Windows omp ancestor when context selects one of multiple pi descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'omp.exe',
        commandLine: 'omp.exe'
      },
      {
        pid: 102,
        ppid: 101,
        name: 'pi.exe',
        commandLine: 'pi.exe --cwd C:\\repo\\orca'
      },
      {
        pid: 103,
        ppid: 100,
        name: 'pi.exe',
        commandLine: 'pi.exe --cwd C:\\repo\\other'
      }
    ])

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
    mockWindowsRows()

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('codex')
  })

  it('recognizes Windows shell-rooted agent launches from descendant command lines', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows()

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('recognizes the native Windows Cursor launcher process tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'cmd.exe',
        commandLine: 'cmd.exe /c cursor-agent.cmd'
      },
      {
        pid: 102,
        ppid: 101,
        name: 'powershell.exe',
        commandLine:
          'powershell.exe -File C:\\Users\\dev\\AppData\\Local\\cursor-agent\\cursor-agent.ps1'
      },
      {
        pid: 103,
        ppid: 102,
        name: 'node.exe',
        commandLine:
          'node.exe C:\\Users\\dev\\AppData\\Local\\cursor-agent\\versions\\2026.07.09-a3815c0\\index.js'
      },
      {
        pid: 104,
        ppid: 103,
        name: 'node.exe',
        commandLine:
          'node.exe C:\\Users\\dev\\AppData\\Local\\cursor-agent\\versions\\2026.07.09-a3815c0\\index.js worker-server'
      },
      {
        pid: 105,
        ppid: 100,
        name: 'agent.exe',
        commandLine: 'C:\\Users\\dev\\.grok\\bin\\agent.exe'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('cursor-agent')
  })

  it('recognizes Windows Git Bash shell-rooted agent launches', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'bash.exe',
        commandLine: 'C:\\Program Files\\Git\\bin\\bash.exe --login -i'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'bash.exe')).resolves.toBe('codex')
  })

  it('keeps a multiline Windows command line inside its own row', async () => {
    // The prompt text impersonates another row; recognition must read the row
    // it belongs to rather than the process it names.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine: [
          'node',
          'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
          '--prompt',
          '"line one\r\nName=gemini.exe\r\nProcessId=999"'
        ].join(' ')
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe('codex')
  })

  it('distinguishes unavailable Windows enumeration from a confirmed shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockUnreadableWindowsTable()

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('treats an observed Windows shell with no children as authoritative', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not restore a recognized fallback that disappeared before confirmation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'droid', {
        fresh: true,
        forceProcessScan: true
      })
    ).resolves.toEqual({ available: true, processName: null })
  })

  it('treats a Windows snapshot missing the requested shell as unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 200,
        ppid: 99,
        name: 'unrelated.exe',
        commandLine: 'unrelated.exe'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe')
    ).resolves.toEqual({ available: false, processName: 'powershell.exe' })
    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('does not use unrelated Windows agent descendants for wrapper fallbacks', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine: 'node C:\\repo\\server.js'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'codex.exe',
        commandLine: 'codex'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('fails closed for ambiguous Windows shell-rooted agent descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'powershell.exe')).resolves.toBe(
      'powershell.exe'
    )
  })

  it('filters detached agents before resolving an otherwise ambiguous ConPTY tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'droid.exe',
        commandLine: 'droid'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'agy.exe',
        commandLine: 'agy'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({ available: true, processName: 'droid' })
  })

  it('recognizes a Windows shell-rooted agent when only one candidate matches the worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js --cwd C:\\repo\\orca'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.mjs --cwd C:\\repo\\other'
      }
    ])

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('codex')
  })

  it('recognizes the deepest Windows shell-rooted agent when candidates share one lineage', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'codex.exe',
        commandLine: 'codex --cwd C:\\repo\\orca'
      },
      {
        pid: 102,
        ppid: 101,
        name: 'gemini.exe',
        commandLine: 'gemini --cwd C:\\repo\\orca'
      }
    ])

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('gemini')
  })

  it('fails closed for sibling Windows agents that both match the same worktree path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'codex.exe',
        commandLine: 'codex --cwd C:\\repo\\orca'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'gemini.exe',
        commandLine: 'gemini --cwd C:\\repo\\orca'
      }
    ])

    await expect(
      resolveAgentForegroundProcess(100, 'powershell.exe', {
        contextPaths: ['C:\\repo\\orca']
      })
    ).resolves.toBe('powershell.exe')
  })

  it('fails closed when Windows has multiple matching wrapper descendants', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine: 'node C:\\repo\\server.js'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
      }
    ])

    await expect(resolveAgentForegroundProcess(100, 'node.exe')).resolves.toBe('node.exe')
  })

  it('does not enrich Windows foregrounds that are not interpreter wrappers', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    await expect(resolveAgentForegroundProcess(100, 'vim.exe')).resolves.toBe('vim.exe')
    expect(getAllProcessesMock).not.toHaveBeenCalled()
  })

  it('authorizes a fresh Windows agent only when it still belongs to the ConPTY', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'droid.exe',
        commandLine: 'droid'
      }
    ])
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
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'droid.exe',
        commandLine: 'droid'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConptyProcessIds: async () => new Set([100, 999])
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('does not fork the ConPTY membership helper when no Windows agent is inferred', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      }
    ])
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
