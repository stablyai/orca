import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../../shared/process-table-snapshot'

import { createDaemonPtySubprocessHandle } from '../subprocess-handle'
import { inspectSpawnFileChildProcessesFromRows } from '../spawn-file-child-processes'

const { members, readWindows } = vi.hoisted(() => ({
  members: vi.fn(),
  readWindows: vi.fn()
}))

vi.mock('../../../providers/foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: members,
  isWindowsPtyJobReadable: () => true
}))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessIdentityTable: readWindows,
  readWindowsProcessIdentityTableFresh: readWindows
}))

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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
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
