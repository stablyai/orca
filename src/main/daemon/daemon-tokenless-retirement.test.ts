import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  statSyncMock,
  readWindowsProcessTableFreshMock,
  getStrictProcessTableSnapshotMock,
  inspectDaemonProcessIdentityMock,
  terminateIdentifiedDaemonMock
} = vi.hoisted(() => ({
  statSyncMock: vi.fn((_path: string): unknown => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }),
  readWindowsProcessTableFreshMock: vi.fn(),
  getStrictProcessTableSnapshotMock: vi.fn(),
  inspectDaemonProcessIdentityMock: vi.fn(async () => 'match'),
  terminateIdentifiedDaemonMock: vi.fn(async () => ({ exited: true, liveOwnerSurvived: false }))
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  statSync: statSyncMock
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTableFresh: readWindowsProcessTableFreshMock
}))
vi.mock('../../shared/process-table-snapshot-reader', () => ({
  getStrictProcessTableSnapshot: getStrictProcessTableSnapshotMock
}))
vi.mock('./daemon-pid-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inspectDaemonProcessIdentity: inspectDaemonProcessIdentityMock
}))
vi.mock('./daemon-process-start-time', () => ({
  getProcessStartedAtMs: () => 7_000
}))
vi.mock('./daemon-stale-kill', () => ({
  terminateIdentifiedDaemon: terminateIdentifiedDaemonMock
}))

import { retireTokenlessDaemon } from './daemon-tokenless-retirement'

const SOCKET = '\\\\?\\pipe\\orca-terminal-host-v36-c92a5413b450'
const TOKEN = 'C:\\Users\\u\\AppData\\Roaming\\orca\\daemon\\daemon-v36.token'
const DAEMON_COMMAND = `Orca.exe out\\main\\daemon-entry.js --socket ${SOCKET} --token ${TOKEN}`

function mockProcessRows(rows: { pid: number; command: string; creationTimeMs?: number }[]): void {
  readWindowsProcessTableFreshMock.mockResolvedValue(
    rows.map((row) => ({ ppid: 1, name: 'Orca.exe', ...row }))
  )
  getStrictProcessTableSnapshotMock.mockResolvedValue(
    rows.map((row) => ({ ppid: 1, stat: 'S', ...row }))
  )
}

describe('retireTokenlessDaemon', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    statSyncMock.mockReset().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    inspectDaemonProcessIdentityMock.mockResolvedValue('match')
    terminateIdentifiedDaemonMock.mockClear()
    mockProcessRows([
      { pid: 11_932, command: DAEMON_COMMAND, creationTimeMs: 1_000 },
      { pid: 22, command: 'powershell.exe -NoExit -EncodedCommand abc' },
      { pid: 33, command: DAEMON_COMMAND.replace('v36', 'v37') }
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('terminates the one process whose command line names this endpoint and token', async () => {
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(true)
    // Why: non-Windows rows carry no ms start time, so it is resolved to keep the recheck meaningful.
    const expectedStart = process.platform === 'win32' ? 1_000 : 7_000
    expect(terminateIdentifiedDaemonMock).toHaveBeenCalledWith(11_932, expectedStart, SOCKET, TOKEN)
  })

  it('does nothing when no process can be named', async () => {
    mockProcessRows([{ pid: 22, command: 'powershell.exe' }])
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('does nothing when several processes match, since it cannot tell which one serves', async () => {
    mockProcessRows([
      { pid: 1, command: DAEMON_COMMAND },
      { pid: 2, command: DAEMON_COMMAND }
    ])
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('does nothing when the token reappeared, because the daemon is reachable again', async () => {
    statSyncMock.mockReset().mockReturnValue({})
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('does nothing when the token cannot be proven absent', async () => {
    // Why: a permission or sharing error on a present token is not evidence the daemon is unreachable.
    statSyncMock.mockReset().mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('re-checks the token after the slow identity inspection, right before signalling', async () => {
    inspectDaemonProcessIdentityMock.mockImplementationOnce(async () => {
      statSyncMock.mockReset().mockReturnValue({})
      return 'match'
    })
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('does nothing when the identity check is inconclusive', async () => {
    inspectDaemonProcessIdentityMock.mockResolvedValue('unknown')
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('does nothing when the process table cannot be read', async () => {
    readWindowsProcessTableFreshMock.mockRejectedValue(new Error('no table'))
    getStrictProcessTableSnapshotMock.mockRejectedValue(new Error('no table'))
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
    expect(terminateIdentifiedDaemonMock).not.toHaveBeenCalled()
  })

  it('reports false when the daemon survives termination', async () => {
    terminateIdentifiedDaemonMock.mockResolvedValueOnce({ exited: false, liveOwnerSurvived: true })
    await expect(retireTokenlessDaemon(SOCKET, TOKEN, 36)).resolves.toBe(false)
  })
})
