import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, getAllProcessesMock, runProcessMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getAllProcessesMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  runProcessMock: vi.fn()
}))

// The process-table snapshot (`ps -axo`) is an allowlisted direct execFile
// caller; the probes themselves go through runProcess.
vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: runProcessMock
}))

import { resetWindowsProcessRowsSnapshotForTests } from '../main/providers/windows-foreground-process-rows'
import { __setWindowsProcessTreeLoaderForTests } from '../main/windows/windows-process-table'
import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot'
import {
  getForegroundProcessName,
  isProcessAlive,
  observeForegroundProcess,
  probeProcessChildren,
  processHasChildren
} from './pty-process-probes'

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

type ProbeProcessResult = {
  code: number | null
  stdout?: string
  signal?: NodeJS.Signals | null
  timedOut?: boolean
}

/**
 * Feed the probes' runProcess calls. Return an Error to reject the way
 * runProcess does when the probe binary could not be spawned at all.
 */
function mockRunProcess(
  implementation: (program: string, args: string[]) => ProbeProcessResult | Error
): void {
  runProcessMock.mockImplementation(async (spec: { program: string; args?: readonly string[] }) => {
    const result = implementation(spec.program, [...(spec.args ?? [])])
    if (result instanceof Error) {
      throw result
    }
    return {
      code: result.code,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: '',
      timedOut: result.timedOut ?? false
    }
  })
}

function spawnFailure(message: string, code: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function timedOutProbe(): ProbeProcessResult {
  return { code: null, signal: 'SIGTERM', timedOut: true }
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
  runProcessMock.mockReset()
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

describe('getForegroundProcessName', () => {
  it('returns clear non-wrapper foregrounds without process-table enrichment', async () => {
    await expect(getForegroundProcessName(100, 'vim')).resolves.toBe('vim')

    expect(execFileMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
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
    mockRunProcess(() => new Error('unexpected probe subprocess'))

    await expect(getForegroundProcessName(100, 'omp')).resolves.toBe('omp')
    expect(execFileMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
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

  it('falls back to the root process command when descendant inspection fails', async () => {
    mockExecFile(() => new Error('ps table unavailable'))
    mockRunProcess(() => ({ code: 0, stdout: 'bash\n' }))

    await expect(getForegroundProcessName(100)).resolves.toBe('bash')
  })
})

describe('probeProcessChildren', () => {
  it('reports live children from pgrep output', async () => {
    mockRunProcess(() => ({ code: 0, stdout: '4242\n' }))

    await expect(probeProcessChildren(100)).resolves.toEqual({ verdict: 'live' })
  })

  it('treats pgrep exit 1 as positive absence', async () => {
    // pgrep exits 1 with no output when it ran and matched nothing.
    mockRunProcess(() => ({ code: 1 }))

    await expect(probeProcessChildren(100)).resolves.toEqual({ verdict: 'exited' })
  })

  it('keeps a missing pgrep binary unverifiable, never exited', async () => {
    mockRunProcess(() => spawnFailure('spawn pgrep ENOENT', 'ENOENT'))

    await expect(probeProcessChildren(100)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('keeps a timed-out pgrep unverifiable, never exited', async () => {
    mockRunProcess(() => timedOutProbe())

    await expect(probeProcessChildren(100)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('keeps a pgrep fatal error (exit 3) unverifiable', async () => {
    mockRunProcess(() => ({ code: 3 }))

    await expect(probeProcessChildren(100)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('answers live from the Windows process table', async () => {
    await withProcessPlatform('win32', async () => {
      mockWindowsProcessTable([
        { pid: 100, ppid: 99, name: 'powershell.exe' },
        { pid: 101, ppid: 100, name: 'codex.exe' }
      ])

      await expect(probeProcessChildren(100)).resolves.toEqual({ verdict: 'live' })
    })
  })

  it('answers exited when the Windows table observes a childless root', async () => {
    await withProcessPlatform('win32', async () => {
      mockWindowsProcessTable([{ pid: 100, ppid: 99, name: 'powershell.exe' }])

      await expect(probeProcessChildren(100)).resolves.toEqual({ verdict: 'exited' })
    })
  })

  it('keeps a Windows table that misses the PTY root unverifiable', async () => {
    await withProcessPlatform('win32', async () => {
      mockWindowsProcessTable([])

      await expect(probeProcessChildren(100)).resolves.toMatchObject({ verdict: 'unverifiable' })
    })
  })

  it('collapses every probe failure to false for the legacy boolean', async () => {
    mockRunProcess(() => spawnFailure('spawn pgrep ENOENT', 'ENOENT'))

    await expect(processHasChildren(100)).resolves.toBe(false)
  })

  it('collapses a non-zero pgrep exit to false for the legacy boolean', async () => {
    mockRunProcess(() => ({ code: 1 }))

    await expect(processHasChildren(100)).resolves.toBe(false)
  })
})

describe('observeForegroundProcess', () => {
  it('reports a successful ps read as observed', async () => {
    mockExecFile((_command, args) => {
      if (args[0] === '-axo') {
        return { stdout: '' }
      }
      return new Error('unexpected direct subprocess')
    })
    mockRunProcess(() => ({ code: 0, stdout: 'vim\n' }))

    await expect(observeForegroundProcess(100)).resolves.toEqual({
      verdict: 'observed',
      processName: 'vim'
    })
  })

  it('reports ps exit 1 as an observed absence of the process', async () => {
    mockExecFile(() => new Error('ps table unavailable'))
    mockRunProcess(() => ({ code: 1 }))

    await expect(observeForegroundProcess(100)).resolves.toEqual({
      verdict: 'observed',
      processName: null
    })
  })

  it('keeps a timed-out ps read unverifiable', async () => {
    mockExecFile(() => new Error('ps table unavailable'))
    mockRunProcess(() => timedOutProbe())

    await expect(observeForegroundProcess(100)).resolves.toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it('keeps the node-pty fallback observed when descendant enrichment fails', async () => {
    mockExecFile(() => new Error('ps table unavailable'))
    mockRunProcess(() => timedOutProbe())

    await expect(observeForegroundProcess(100, 'node')).resolves.toEqual({
      verdict: 'observed',
      processName: 'node'
    })
  })

  it('collapses an unverifiable observation to null for the legacy reader', async () => {
    mockExecFile(() => new Error('ps table unavailable'))
    mockRunProcess(() => timedOutProbe())

    await expect(getForegroundProcessName(100)).resolves.toBeNull()
  })
})
