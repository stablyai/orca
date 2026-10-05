import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as SnapshotReader from '../../shared/process-table-snapshot-reader'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { resolveSpawnFileForegroundFromRows } from './pty-subprocess/spawn-file-foreground-process'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'
import { Session } from './session'
const { readSnapshot, readFresh, readStrict, members, readWindows, resolveWindows } = vi.hoisted(
  () => ({
    readSnapshot: vi.fn(),
    readFresh: vi.fn(),
    readStrict: vi.fn(),
    members: vi.fn(),
    readWindows: vi.fn(),
    resolveWindows: vi.fn()
  })
)
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getProcessTableSnapshot: readSnapshot,
  getFreshProcessTableSnapshot: readFresh,
  getStrictProcessTableSnapshotWithAge: readStrict
}))
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: members,
  isWindowsPtyJobReadable: () => true
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessIdentityTable: readWindows,
  readWindowsProcessIdentityTableFresh: readWindows
}))
vi.mock('../providers/windows-agent-foreground-process', () => ({
  shouldInspectWindowsAgentForeground: () => true,
  resolveWindowsAgentForegroundProcessWithAvailability: resolveWindows
}))

function table(command: string | null, loginWrapper = false): ProcessTableRow[] {
  const tpgid = command === null ? (loginWrapper ? 101 : 100) : 102
  const root: ProcessTableRow = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid,
    tty: 'ttys004',
    startTime: 'Thu Sep  3 16:02:01 2026',
    stat: tpgid === 100 ? 'Ss+' : 'Ss',
    command: loginWrapper ? '"/Applications/Orca shell login" -fp user' : '/bin/zsh'
  }
  return [
    root,
    ...(loginWrapper
      ? [
          {
            ...root,
            pid: 101,
            ppid: 100,
            pgid: 101,
            stat: command === null ? 'S+' : 'S',
            command: '-zsh'
          }
        ]
      : []),
    ...(command === null
      ? []
      : [{ ...root, pid: 102, ppid: loginWrapper ? 101 : 100, pgid: 102, stat: 'S+', command }])
  ]
}

function createHandle(loginWrapper = false) {
  const proc: IPty & { processNameIsSpawnFile: true } = {
    pid: 100,
    cols: 80,
    rows: 24,
    handleFlowControl: false,
    process: loginWrapper ? '/Applications/Orca shell login' : '/bin/zsh',
    processNameIsSpawnFile: true,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    clear() {},
    kill() {},
    pause() {},
    resume() {}
  }
  return createDaemonPtySubprocessHandle({
    process: proc,
    shellPath: '/bin/zsh',
    spawnCwd: '/tmp',
    env: {},
    startupCommandDeliveredInShellArgs: false,
    reportsChildExitStatus: true,
    sessionId: 'static-name',
    startupAgentRecognition: null
  })
}

async function inspect(handle: ReturnType<typeof createHandle>) {
  const session = new Session({
    sessionId: 'static-name',
    subprocess: handle,
    shellReadySupported: false,
    cols: 80,
    rows: 24,
    scrollback: 10
  })
  try {
    return await inspectTerminalHostProcess({
      sessionId: session.sessionId,
      session,
      authorityGeneration: 'generation',
      nextObservationEpoch: () => 1
    })
  } finally {
    session.dispose()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe.each(['linux', 'darwin'] as const)('static spawn-file foreground on %s', (platform) => {
  it.each(['vim', 'sleep', 'node', 'npm', 'node /usr/bin/claude'])(
    'resolves %s in both the synchronous tracker and host inspection',
    async (command) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const rows = table(command, platform === 'darwin')
      readSnapshot.mockResolvedValue(rows)
      readFresh.mockResolvedValue(rows)
      readStrict.mockResolvedValue({ rows, capturedAgeMs: 0 })
      const handle = createHandle(platform === 'darwin')
      const expected = command.includes('claude') ? 'claude' : command
      expect(handle.processNameIsSpawnFile).toBe(true)
      expect(await handle.confirmForegroundProcess?.()).toBe(expected)
      expect(handle.getForegroundProcess()).toBe(expected)
      expect(await inspect(createHandle(platform === 'darwin'))).toMatchObject({
        foregroundProcess: expected,
        hasChildProcesses: true
      })
      expect(readStrict).toHaveBeenCalledTimes(1)
    }
  )

  it('observes a command ending and returns to an idle login shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const handle = createHandle(true)
    readFresh.mockResolvedValue(table('vim', true))
    expect(await handle.confirmForegroundProcess?.()).toBe('vim')
    const rows = table(null, true)
    readFresh.mockResolvedValue(rows)
    readSnapshot.mockResolvedValue(rows)
    readStrict.mockResolvedValue({ rows, capturedAgeMs: 0 })
    expect(await handle.confirmForegroundProcess?.()).toBe('zsh')
    const inspection = await inspect(handle)
    expect(inspection).toMatchObject({
      foregroundProcess: null,
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })
  })

  it('does not interpret a failed process read as a childless shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    readFresh.mockRejectedValue(new Error('unreadable'))
    readSnapshot.mockRejectedValue(new Error('unreadable'))
    readStrict.mockRejectedValue(new Error('unreadable'))
    const handle = createHandle()
    expect(await handle.confirmForegroundProcess?.()).toBeNull()
    const inspection = await inspect(handle)
    expect(inspection).toMatchObject({
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundProcessEvidence: { verdict: 'unverifiable' }
    })
  })

  it('retains ordinary foreground names across a failed background refresh', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(100_000)
    readSnapshot.mockResolvedValue(table('vim'))
    const handle = createHandle()
    expect(handle.getForegroundProcess()).toBe('zsh')
    await vi.waitFor(() => expect(handle.getForegroundProcess()).toBe('vim'))
    readSnapshot.mockRejectedValue(new Error('unreadable'))
    vi.setSystemTime(102_000)
    expect(handle.getForegroundProcess()).toBe('vim')
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2))
    expect(handle.getForegroundProcess()).toBe('vim')
    handle.dispose()
  })

  it.each(['T', 'S'])(
    'keeps the close guard live when the shell is foreground and a child has state %s',
    async (stat) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const rows = table(null, platform === 'darwin')
      rows.push({ ...rows[0], pid: 102, ppid: rows.at(-1)!.pid, pgid: 102, stat, command: 'vim' })
      readSnapshot.mockResolvedValue(rows)
      readStrict.mockResolvedValue({ rows, capturedAgeMs: 0 })
      const inspection = await inspect(createHandle(platform === 'darwin'))
      expect(inspection).toMatchObject({
        foregroundProcess: null,
        hasChildProcesses: true,
        childProcessEvidence: 'children'
      })
    }
  )
})

it('ignores stopped/background children and another terminal beneath the same root', () => {
  const rows = table(null)
  rows.push({ ...rows[0], pid: 102, ppid: 100, pgid: 102, stat: 'T', command: 'vim' })
  rows.push({ ...rows[0], pid: 103, ppid: 100, tty: 'ttys009', command: 'claude' })
  expect(resolveSpawnFileForegroundFromRows(rows, 100)).toEqual({
    available: true,
    processName: 'zsh'
  })
  expect(resolveSpawnFileForegroundFromRows(rows, 999)).toEqual({
    available: false,
    processName: null
  })
})

it('uses Windows job membership and the native process table for ordinary children', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(new Set([100, 102]))
  readWindows.mockResolvedValue([
    { pid: 100, ppid: 1, name: 'pwsh.exe' },
    { pid: 102, ppid: 100, name: 'vim.exe' }
  ])
  readStrict.mockRejectedValue(new Error('POSIX evidence unavailable'))
  const handle = createHandle()
  expect(await handle.confirmForegroundProcess?.()).toBe('vim.exe')
  expect(await inspect(handle)).toMatchObject({
    foregroundProcess: 'vim.exe',
    hasChildProcesses: true
  })
})

it('keeps missing Windows job membership unverifiable', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(null)
  readStrict.mockRejectedValue(new Error('POSIX evidence unavailable'))
  expect(await inspect(createHandle())).toMatchObject({
    foregroundProcess: null,
    hasChildProcesses: true,
    childProcessEvidence: 'unverifiable'
  })
})

it('reports an idle Windows shell only when the owned job contains the shell alone', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(new Set([100]))
  readStrict.mockRejectedValue(new Error('POSIX evidence unavailable'))
  expect(await inspect(createHandle())).toMatchObject({ hasChildProcesses: false })
  expect(readWindows).not.toHaveBeenCalled()
})

it('keeps the Windows close guard live when a shell descendant is selected above another job', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(new Set([100, 102, 103, 104]))
  readWindows.mockResolvedValue([
    { pid: 100, ppid: 1, name: 'pwsh.exe' },
    { pid: 102, ppid: 100, name: 'vim.exe' },
    { pid: 103, ppid: 100, name: 'cmd.exe' },
    { pid: 104, ppid: 103, name: 'pwsh.exe' }
  ])
  readStrict.mockRejectedValue(new Error('POSIX evidence unavailable'))
  const inspection = await inspect(createHandle())
  expect(inspection).toMatchObject({ hasChildProcesses: true, childProcessEvidence: 'children' })
})
