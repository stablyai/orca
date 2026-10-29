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
// Toolhelp denial may return an empty table; require the querying process to distinguish a readable snapshot.
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
    // Reset the 500ms Windows snapshot cache so each case reads its own rows.
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

  it('does not report a suspended agent when a non-agent holds the foreground', async () => {
    // vim owns foreground (+); Ctrl-Z left Codex as a stopped background descendant.
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
    // OMP identity must survive samples where only the wrapped Pi child owns foreground.
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

  it('confirms a quoted login shell only when its fresh PTY tree contains shells', async () => {
    mockPs(['100 99 100 100 Ss+ "/bin/zsh" -l', '101 100 101 100 S+ /bin/bash'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(true)
  })

  it('uses spawned-shell identity instead of a lagging foreground child label', async () => {
    mockPs(['100 99 100 100 Ss+ /bin/zsh -l'].join('\n'))

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('confirms the spawned shell behind a login wrapper while prompt hooks run', async () => {
    mockPs(
      [
        '100 99 100 101 Ss /usr/bin/login -pfl developer /bin/zsh',
        '101 100 101 101 S+ -zsh',
        '102 101 101 101 S+ (zsh)',
        '103 102 101 101 S+ (sed)',
        '104 102 101 101 R+ (git)'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('rejects a foreground nested shell while the spawned shell remains suspended', async () => {
    mockPs(
      [
        '100 99 100 102 Ss /usr/bin/login -pfl developer /bin/zsh',
        '101 100 101 102 S -zsh',
        '102 101 102 102 S+ agent-tui',
        '103 102 102 102 S+ /bin/zsh -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a TUI and its nested shell remain in the PTY tree', async () => {
    mockPs(
      [
        '100 99 100 101 Ss /bin/zsh -l',
        '101 100 101 101 S+ /usr/local/bin/agent-tui',
        '102 101 101 101 S+ /bin/bash -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a stopped TUI remains resumable', async () => {
    mockPs(['100 99 100 100 Ss+ /bin/zsh -l', '101 100 101 100 T agent-tui'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('refuses WSL shells: wsl.exe is not a provable shell identity', async () => {
    // The WSL job holds only wsl.exe and cannot prove guest-side shell state.
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
    // Detached descendants may have no foreground marker; retain agent recognition as a fallback.
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
    // Prompt text impersonates another row; keep it within its actual process command line.
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

  it('reports a foreign anchor when its pid now runs an unrecognized command', async () => {
    // Job membership cannot preserve an agent identity contradicted by immutable command-line evidence.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 100, name: 'node.exe', commandLine: 'node server.js' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999
      })
    ).resolves.toEqual({
      available: true,
      processName: 'powershell.exe',
      anchorPidForeign: true
    })
  })

  it('detects a foreign anchor even when the squatter is orphaned out of the descendant walk', async () => {
    // PID reuse can leave the squatter outside the shell ancestry while retaining job membership.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 500, name: 'node.exe', commandLine: 'node server.js' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999
      })
    ).resolves.toEqual({
      available: true,
      processName: 'powershell.exe',
      anchorPidForeign: true
    })
  })

  it('flags an anchor recycled by a DIFFERENT agent as foreign', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 500, name: 'node.exe', commandLine: 'node /usr/bin/codex' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999,
        anchorProcessName: 'claude'
      })
    ).resolves.toEqual({
      available: true,
      processName: 'powershell.exe',
      anchorPidForeign: true
    })
  })

  it('does not flag an anchor whose row still recognizes as the cached agent', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 500, name: 'node.exe', commandLine: 'node C:\\npm\\claude' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999,
        anchorProcessName: 'claude'
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('treats a query-denied anchor row as inconclusive, never foreign', async () => {
    // A denied query yields command === name; the agent may just be unreadable.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 100, name: 'node.exe', commandLine: '' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
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
        readWindowsConsoleAttachedProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({
      available: true,
      processName: 'droid',
      processId: 101
    })
  })

  it('fails closed when console attachment cannot be read', async () => {
    // Unreadable console attachment cannot authorize a detached descendant as the pane agent (#16419).
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 200, ppid: 199, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 201, ppid: 200, name: 'droid.exe', commandLine: 'droid' },
      { pid: 202, ppid: 200, name: 'agy.exe', commandLine: 'agy' }
    ])

    const reader = vi.fn(async () => null)

    const resolution = await resolveAgentForegroundProcessWithAvailability(200, 'powershell.exe', {
      fresh: true,
      readWindowsConsoleAttachedProcessIds: reader
    })

    expect(reader).toHaveBeenCalledTimes(1)
    // Unavailable evidence must yield the shell fallback, never an unverified agent identity.
    expect(resolution.available).toBe(false)
    expect(resolution.processName).toBe('powershell.exe')
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
    const readWindowsConsoleAttachedProcessIds = vi.fn(async () => new Set([100, 101, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds
      })
    ).resolves.toEqual({
      available: true,
      processName: 'droid',
      processId: 101
    })
    expect(readWindowsConsoleAttachedProcessIds).toHaveBeenCalledTimes(1)
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
        readWindowsConsoleAttachedProcessIds: async () => new Set([100, 999])
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
    const readWindowsConsoleAttachedProcessIds = vi.fn(async () => new Set([100, 999]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
    expect(readWindowsConsoleAttachedProcessIds).not.toHaveBeenCalled()
  })
})
