import { describe, expect, it, vi } from 'vitest'
import type { WindowsProcessIdentityRow } from '../../../windows/windows-process-table'
import { isWindowsShellAloneInJob } from './shell-alone-in-job'

const LAUNCHER = 'C:\\Program Files\\Git\\bin\\bash.exe'
const row = (pid: number, ppid: number, name = 'bash.exe'): WindowsProcessIdentityRow => ({
  pid,
  ppid,
  name
})
// Measured on Windows: launcher -> exec stub -> interactive bash, then rc-started ssh-agent and
// `sleep 600 &`, both under exited Win32 parents; only the sleep stayed on the console.
const IDLE = [row(10, 1), row(11, 10), row(12, 11)]
const SSH_AGENT = row(20, 2184, 'ssh-agent.exe')
const SLEEP = row(21, 39140, 'sleep.exe')
const CONSOLE = new Set([10, 11, 12, 21])

function alone(
  shellPath: string,
  rows: WindowsProcessIdentityRow[],
  consoleIds: ReadonlySet<number> | null = CONSOLE
): { result: Promise<boolean>; readConsole: ReturnType<typeof vi.fn> } {
  const readConsole = vi.fn(async () => consoleIds)
  const result = isWindowsShellAloneInJob(
    10,
    shellPath,
    new Set(rows.map((r) => r.pid)),
    async () => rows,
    readConsole
  )
  return { result, readConsole }
}

describe('isWindowsShellAloneInJob for adoption', () => {
  it('sets aside a member that left both the shell tree and the console', async () => {
    await expect(alone(LAUNCHER, [...IDLE, SSH_AGENT]).result).resolves.toBe(true)
    await expect(alone(LAUNCHER, [...IDLE, SSH_AGENT, SLEEP]).result).resolves.toBe(false)
    const pwsh = [row(10, 1, 'pwsh.exe'), SSH_AGENT]
    await expect(alone('pwsh.exe', pwsh).result).resolves.toBe(true)
    // `Start-Process` leaves the console but keeps its live parent: still running work.
    const detachedChild = row(22, 10, 'claude.exe')
    await expect(alone('pwsh.exe', [...pwsh, detachedChild]).result).resolves.toBe(false)
  })

  it('keeps every member when the console cannot be read, and reads it only for orphans', async () => {
    await expect(alone(LAUNCHER, [...IDLE, SSH_AGENT], null).result).resolves.toBe(false)
    const idle = alone(LAUNCHER, IDLE)
    await expect(idle.result).resolves.toBe(true)
    expect(idle.readConsole).not.toHaveBeenCalled()
  })
})

describe('isWindowsShellAloneInJob for a shell-only job', () => {
  // Packaged shells (MSIX Store pwsh) run their children outside the PTY job object (#39037).
  const pwsh = row(10, 1, 'pwsh.exe')

  function aloneWithJob(
    job: number[],
    rows: WindowsProcessIdentityRow[] | Error
  ): Promise<boolean> {
    return isWindowsShellAloneInJob(10, 'pwsh.exe', new Set(job), async () => {
      if (rows instanceof Error) {
        throw rows
      }
      return rows
    })
  }

  it('reports idle only when the PPID tree has no descendants', async () => {
    await expect(aloneWithJob([10], [pwsh])).resolves.toBe(true)
    await expect(aloneWithJob([10], [pwsh, row(22, 10, 'claude.exe')])).resolves.toBe(false)
  })

  it('ignores a stale ppid whose process predates the shell (pid reuse)', async () => {
    await expect(
      aloneWithJob(
        [10],
        [
          { ...pwsh, creationTimeMs: 2_000 },
          { pid: 22, ppid: 10, name: 'unrelated.exe', creationTimeMs: 1_000 }
        ]
      )
    ).resolves.toBe(true)
  })

  it('fails closed when the table is unreadable or lacks the shell row', async () => {
    await expect(aloneWithJob([10], new Error('unreadable'))).rejects.toThrow('unreadable')
    await expect(aloneWithJob([10], [row(11, 10)])).resolves.toBe(false)
  })
})
