import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WindowsProcessRow } from '../windows/windows-process-table'

const { readWindowsProcessTableFresh } = vi.hoisted(() => ({
  readWindowsProcessTableFresh: vi.fn<() => Promise<WindowsProcessRow[]>>()
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTableFresh,
  readWindowsProcessCreationTime: () => null
}))

const { inspectDaemonProcessIdentity } = await import('./daemon-pid-identity')

const socketPath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\daemon\\daemon-v4.sock'
const tokenPath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\daemon\\daemon-v4.token'
const STARTED_AT_MS = 1_700_000_000_000
// process.kill(pid, 0) must succeed, so the row under test is this process's own.
const pid = process.pid

function table(
  command: string,
  creationTimeMs = STARTED_AT_MS
): () => Promise<WindowsProcessRow[]> {
  return async () => [{ pid, ppid: 1, name: 'Orca.exe', command, creationTimeMs }]
}

const daemon = `"C:\\Orca\\Orca.exe" daemon-entry.js --socket ${socketPath} --token ${tokenPath}`
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('inspectDaemonProcessIdentity on Windows', () => {
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it.each([
    ['match', 'the daemon within the bootstrap tolerance', table(daemon, STARTED_AT_MS - 2_000)],
    ['mismatch', 'a reused PID', table(daemon, STARTED_AT_MS + 60 * 60_000)],
    ['mismatch', 'a different command line', table('C:\\Windows\\notepad.exe')],
    ['unknown', 'a denied command line', table('')],
    ['unknown', 'an absent row', async () => []],
    [
      'unknown',
      'an unreadable table',
      async () => {
        throw new Error('unavailable')
      }
    ]
  ])('reports %s for %s', async (expected, _case, readTable) => {
    readWindowsProcessTableFresh.mockImplementationOnce(readTable)

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe(expected)
  })
})
