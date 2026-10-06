import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import { __setWindowsProcessTreeLoaderForTests } from '../../windows/windows-process-table'
import {
  resolveSpawnFileForegroundFromRows,
  resolveSpawnFileForegroundProcess
} from './spawn-file-foreground-process'

const { members } = vi.hoisted(() => ({ members: vi.fn() }))
vi.mock('../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: members
}))

const proc: IPty = {
  pid: 100,
  cols: 80,
  rows: 24,
  handleFlowControl: false,
  process: 'powershell.exe',
  onData: () => ({ dispose() {} }),
  onExit: () => ({ dispose() {} }),
  write() {},
  resize() {},
  clear() {},
  kill() {},
  pause() {},
  resume() {}
}

const root: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 101,
  tty: 'pts/test',
  stat: 'S',
  startTime: 'shell-start',
  command: '/bin/zsh'
}

beforeEach(() => members.mockReturnValue(new Set([100, 101, 102])))
afterEach(() => {
  __setWindowsProcessTreeLoaderForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('POSIX static-name agent selection', () => {
  it('does not pick a rejected sibling agent by its executable basename', () => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [
          root,
          { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command: 'claude' },
          { ...root, pid: 102, ppid: 100, pgid: 101, stat: 'S+', command: 'codex' }
        ],
        100
      )
    ).toEqual({ available: true, processName: null })
  })

  it('does not promote a headless one-shot agent from its executable basename', () => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [
          root,
          { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command: 'claude -p "review"' }
        ],
        100
      )
    ).toEqual({ available: true, processName: null })
  })

  it.each(['vim', 'npm', 'sleep'])('retains the ordinary %s name', (command) => {
    expect(
      resolveSpawnFileForegroundFromRows(
        [root, { ...root, pid: 101, ppid: 100, pgid: 101, stat: 'S+', command }],
        100
      )
    ).toEqual({ available: true, processName: command })
  })
})

describe('Windows static-name agent selection', () => {
  function installRows(names: string[]): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const rows = [
      { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' },
      { pid: 100, ppid: 1, name: 'powershell.exe', commandLine: 'powershell.exe' },
      ...names.map((name, index) => ({ pid: 101 + index, ppid: 100, name, commandLine: name }))
    ]
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: (callback) => callback(rows)
    }))
  }

  it('does not re-admit a detached agent through owned job membership', async () => {
    installRows(['droid.exe'])
    const consoleMembers = vi.fn(async () => new Set([100, 999]))
    expect(
      await resolveSpawnFileForegroundProcess(proc, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: consoleMembers
      })
    ).toEqual({ available: true, processName: 'powershell.exe' })
    expect(consoleMembers).toHaveBeenCalledOnce()
  })

  it('does not choose a rejected sibling agent from the identity table', async () => {
    installRows(['claude.exe', 'codex.exe'])
    expect(
      await resolveSpawnFileForegroundProcess(proc, 'powershell.exe', { fresh: true })
    ).toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('retains a positively authorized agent', async () => {
    installRows(['droid.exe'])
    expect(
      await resolveSpawnFileForegroundProcess(proc, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => new Set([100, 101])
      })
    ).toEqual({ available: true, processName: 'droid', processId: 101 })
  })

  it('retains an ordinary executable from the identity table', async () => {
    installRows(['vim.exe'])
    expect(
      await resolveSpawnFileForegroundProcess(proc, 'powershell.exe', { fresh: true })
    ).toEqual({ available: true, processName: 'vim.exe', processId: 101 })
  })
})
