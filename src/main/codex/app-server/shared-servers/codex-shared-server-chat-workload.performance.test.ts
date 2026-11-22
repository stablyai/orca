import { afterEach, describe, expect, it, vi } from 'vitest'

type Row = { pid: number; parent: number; name: string; env: string }
const host: { rows: Row[]; fileReads: number } = { rows: [], fileReads: 0 }
// Above any real pid, so the test runner's own pid (which a scan skips) is never in the table.
const BASE_PID = 10_000_000
const LAUNCHER_PID = BASE_PID + 1
const SERVER_PID = BASE_PID + 2
const TAGGED_PID = BASE_PID + 3

vi.mock('@orca/process-host', () => ({
  runProcess: async () => ({
    code: 0,
    timedOut: false,
    outputTruncated: false,
    stdout: host.rows.map((row) => `${row.pid} ${row.parent} ${row.name}`).join('\n')
  })
}))

vi.mock('node:fs/promises', () => ({
  readdir: async () => {
    host.fileReads += 1
    return host.rows.map((row) => String(row.pid))
  },
  stat: async () => {
    host.fileReads += 1
    return { uid: process.getuid?.() }
  },
  readFile: async (path: string) => {
    host.fileReads += 1
    const row = host.rows.find((candidate) => candidate.pid === Number(path.split('/')[2]))
    return row?.env ?? ''
  }
}))

const { codexLeaseProcessesGone } = await import('./codex-shared-server-chat-workload')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** `others` unrelated processes of this user, plus a shared server and one of its chat's commands. */
async function fileReadsForOneClose(others: number, launcher: boolean): Promise<number> {
  host.rows = [
    ...(launcher ? [{ pid: LAUNCHER_PID, parent: 1, name: 'orca-provider-e', env: '' }] : []),
    { pid: SERVER_PID, parent: launcher ? LAUNCHER_PID : 1, name: 'codex', env: '' },
    { pid: TAGGED_PID, parent: SERVER_PID, name: 'sleep', env: 'ORCA_CODEX_SHARED_LEASE=a\0' },
    ...Array.from({ length: others }, (_, index) => ({
      pid: BASE_PID + 10 + index,
      parent: 1,
      name: 'sleep',
      env: 'PATH=/bin\0'
    }))
  ]
  host.fileReads = 0
  vi.useFakeTimers()
  const stopped = codexLeaseProcessesGone(SERVER_PID, 'a', undefined, 'linux')
  await vi.runAllTimersAsync()
  await stopped
  return host.fileReads
}

describe('shared Codex chat close (Linux)', () => {
  it("reads only the server's own processes, however many the host runs", async () => {
    const atN = await fileReadsForOneClose(200, true)
    expect(await fileReadsForOneClose(2_000, true)).toBe(atN)
  })

  it('reads no process file without the launcher, since nothing there can prove the close', async () => {
    expect(await fileReadsForOneClose(200, false)).toBe(0)
    expect(await fileReadsForOneClose(2_000, false)).toBe(0)
  })
})
