import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../../shared/process-table-snapshot'
import type * as SnapshotReader from '../../../../shared/process-table-snapshot-reader'
import { createDaemonPtySubprocessHandle } from '../subprocess-handle'
import { inspectSpawnFileChildProcessesFromRows } from '../spawn-file-child-processes'
import { inspectTerminalHostProcess } from '../../terminal-host/terminal-host-process-inspection'
import { Session } from '../../sessions/session'
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
vi.mock('../../../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getProcessTableSnapshot: readSnapshot,
  getFreshProcessTableSnapshot: readFresh,
  getStrictProcessTableSnapshotWithAge: readStrict
}))
vi.mock('../../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: members,
  isWindowsPtyJobReadable: () => true
}))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessIdentityTable: readWindows,
  readWindowsProcessIdentityTableFresh: readWindows
}))
vi.mock('../../../providers/windows-agent-foreground-process', () => ({
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

function createHandle(loginWrapper = false, shellPath = '/bin/zsh') {
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
    shellPath,
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

// ps spells "no controlling terminal" as `?` on Linux, `??` on macOS and `-` on some builds.
describe.each(['??', '?', '-'] as const)('root on no controlling terminal (tty=%s)', (tty) => {
  const detachedRoot: ProcessTableRow = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: 100,
    tty,
    startTime: 'Sat Sep 26 13:44:29 2026',
    stat: 'S',
    command: '/bin/zsh'
  }
  const detachedTree: ProcessTableRow[] = [
    detachedRoot,
    { ...detachedRoot, pid: 101, ppid: 100, pgid: 100, command: 'claude' }
  ]

  it('reports child evidence as unverifiable rather than reading an unfenceable table', () => {
    expect(inspectSpawnFileChildProcessesFromRows(detachedTree, 100, 'zsh')).toBe('unverifiable')
  })
})

it('keeps missing Windows job membership unverifiable', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(null)
  expect(await createHandle().confirmForegroundProcess?.()).toBeNull()
  expect(await inspect(createHandle())).toMatchObject({
    foregroundProcess: 'zsh',
    hasChildProcesses: true,
    childProcessEvidence: 'unverifiable'
  })
})

it('reports an idle Windows shell only when the owned job contains the shell alone', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  resolveWindows.mockResolvedValue({ available: true, processName: null })
  members.mockReturnValue(new Set([100]))
  expect(await inspect(createHandle())).toMatchObject({ hasChildProcesses: false })
  expect(readWindows).not.toHaveBeenCalled()
})

it('accepts only a complete actual-shell Git Bash launch chain', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const shellPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const handle = createHandle(false, shellPath)
  members.mockReturnValue(new Set([100, 102]))
  readWindows.mockResolvedValue([
    { pid: 100, ppid: 1, name: 'bash.exe', creationTimeMs: 1 },
    { pid: 102, ppid: 100, name: 'bash.exe', creationTimeMs: 2 }
  ])
  expect(await handle.inspectChildProcesses?.()).toBe('no-children')
  readWindows.mockResolvedValue([{ pid: 100, ppid: 1, name: 'bash.exe' }])
  expect(await handle.inspectChildProcesses?.()).toBe('unverifiable')
  readWindows.mockResolvedValue([
    { pid: 100, ppid: 1, name: 'bash.exe' },
    { pid: 102, ppid: 100, name: 'agent.exe' }
  ])
  expect(await handle.inspectChildProcesses?.()).toBe('children')
  members.mockReturnValue(new Set([102]))
  expect(await handle.inspectChildProcesses?.()).toBe('unverifiable')
  handle.dispose()
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
  const inspection = await inspect(createHandle())
  expect(inspection).toMatchObject({ hasChildProcesses: true, childProcessEvidence: 'children' })
})
