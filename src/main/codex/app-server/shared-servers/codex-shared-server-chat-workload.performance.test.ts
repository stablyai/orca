import { afterEach, describe, expect, it, vi } from 'vitest'

const proc: { pids: number[]; environReads: number } = { pids: [], environReads: 0 }
// Above any real pid, so the test runner's own pid (which a scan skips) is never in the table.
const BASE_PID = 10_000_000
const SERVER_PID = BASE_PID + 1
const TAGGED_PID = BASE_PID + 2

vi.mock('node:fs/promises', () => ({
  readdir: async () => proc.pids.map(String),
  stat: async () => ({ uid: process.getuid?.() }),
  readFile: async (path: string) => {
    const pid = Number(path.split('/')[2])
    if (path.endsWith('/stat')) {
      // Codex runs with no launcher above it (the unbounded path); every process is under init.
      return pid === SERVER_PID ? `${pid} (codex) S 1 ${pid}` : `${pid} (sleep) S 1 ${pid}`
    }
    proc.environReads += 1
    return pid === TAGGED_PID ? 'ORCA_CODEX_SHARED_LEASE=lease-a\0' : 'PATH=/bin\0'
  }
}))

const { stopCodexLeaseTaggedProcesses } = await import('./codex-shared-server-chat-workload')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function environReadsForOneClose(processes: number): Promise<number> {
  proc.pids = Array.from({ length: processes }, (_, index) => BASE_PID + index + 1)
  proc.environReads = 0
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  expect(await stopCodexLeaseTaggedProcesses(SERVER_PID, 'lease-a', undefined, 'linux')).toBe(false)
  expect(kill).not.toHaveBeenCalled()
  return proc.environReads
}

describe('shared Codex chat close without the launcher (Linux)', () => {
  it('reads no process environment, since nothing there can prove the close', async () => {
    expect(await environReadsForOneClose(200)).toBe(0)
    expect(await environReadsForOneClose(2_000)).toBe(0)
  })
})
