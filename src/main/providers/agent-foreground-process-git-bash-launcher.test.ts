import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import { confirmShellForegroundProcess } from './agent-foreground-process'

const LAUNCHER = 'C:\\Program Files\\Git\\bin\\bash.exe'
const MSYS_BASH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
const LAUNCHER_PID = 9968
const EXEC_STUB_PID = 24472
const SHELL_PID = 2272

const bash = (pid: number, ppid: number, creationTimeMs?: number): WindowsProcessIdentityRow => ({
  pid,
  ppid,
  name: 'bash.exe',
  ...(creationTimeMs === undefined ? {} : { creationTimeMs })
})

// Measured in a real Orca Git Bash pane: launcher -> `-c "chcp.com ...; exec $BASH ..."` stub -> interactive bash.
const IDLE_ROWS: WindowsProcessIdentityRow[] = [
  bash(LAUNCHER_PID, 50),
  bash(EXEC_STUB_PID, LAUNCHER_PID),
  bash(SHELL_PID, EXEC_STUB_PID)
]
const IDLE_JOB = IDLE_ROWS.map((row) => row.pid)

function confirm(
  shellPath: string,
  rows: WindowsProcessIdentityRow[] | Error,
  job: number[] = rows instanceof Error ? IDLE_JOB : rows.map((row) => row.pid)
): { result: Promise<boolean>; readIdentityTable: ReturnType<typeof vi.fn> } {
  const readIdentityTable = vi.fn(async () => {
    if (rows instanceof Error) {
      throw rows
    }
    return rows
  })
  const result = confirmShellForegroundProcess(LAUNCHER_PID, shellPath, {
    readWindowsPtyJobProcessIds: async () => new Set(job),
    readWindowsProcessIdentityTable: readIdentityTable
  })
  return { result, readIdentityTable }
}

describe('Windows shell proof for the Git Bash launcher', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('confirms an idle prompt: launcher, exec stub, interactive bash in one chain', async () => {
    await expect(confirm(LAUNCHER, IDLE_ROWS).result).resolves.toBe(true)
  })

  it('confirms the bare hand-off with no exec stub', async () => {
    await expect(
      confirm(LAUNCHER, [bash(LAUNCHER_PID, 50), bash(SHELL_PID, LAUNCHER_PID)]).result
    ).resolves.toBe(true)
  })

  it('refutes a command at the prompt, directly or behind a fork stub', async () => {
    const vim = { pid: 700, ppid: SHELL_PID, name: 'vim.exe' }
    await expect(confirm(LAUNCHER, [...IDLE_ROWS, vim]).result).resolves.toBe(false)
    const forkStub = bash(600, SHELL_PID)
    await expect(
      confirm(LAUNCHER, [...IDLE_ROWS, forkStub, { ...vim, ppid: forkStub.pid }]).result
    ).resolves.toBe(false)
  })

  it('refutes a background job, which branches the chain', async () => {
    await expect(
      confirm(LAUNCHER, [...IDLE_ROWS, bash(600, SHELL_PID), bash(601, SHELL_PID)]).result
    ).resolves.toBe(false)
    const orphan = { pid: 800, ppid: 1, name: 'node.exe' }
    await expect(confirm(LAUNCHER, [...IDLE_ROWS, orphan]).result).resolves.toBe(false)
  })

  it('confirms a nested bash and a fork caught before its exec: both are a bash leaf', async () => {
    // Accepted residual: a foreground bash of only builtins is indistinguishable from a prompt.
    await expect(confirm(LAUNCHER, [...IDLE_ROWS, bash(600, SHELL_PID)]).result).resolves.toBe(true)
    await expect(
      confirm(LAUNCHER, [...IDLE_ROWS, bash(600, SHELL_PID), bash(601, 600)]).result
    ).resolves.toBe(true)
  })

  it('refutes a reused pid: a member missing from the table or older than its parent', async () => {
    await expect(confirm(LAUNCHER, IDLE_ROWS.slice(0, 2), IDLE_JOB).result).resolves.toBe(false)
    await expect(
      confirm(LAUNCHER, [
        bash(LAUNCHER_PID, 50, 1_000),
        bash(EXEC_STUB_PID, LAUNCHER_PID, 900),
        bash(SHELL_PID, EXEC_STUB_PID, 1_100)
      ]).result
    ).resolves.toBe(false)
    // A job pid reused by an unrelated process between the job read and the table read.
    await expect(
      confirm(LAUNCHER, [
        IDLE_ROWS[0],
        IDLE_ROWS[1],
        { pid: SHELL_PID, ppid: 4, name: 'svchost.exe' }
      ]).result
    ).resolves.toBe(false)
  })

  it('refutes a non-bash link anywhere in the chain', async () => {
    await expect(
      confirm(LAUNCHER, [
        IDLE_ROWS[0],
        { pid: EXEC_STUB_PID, ppid: LAUNCHER_PID, name: 'node.exe' },
        IDLE_ROWS[2]
      ]).result
    ).resolves.toBe(false)
  })

  it('never reads the table for a shell that is not the launcher', async () => {
    // A directly launched MSYS bash with a forked subshell has the same shape as the hand-off.
    const direct = confirm(MSYS_BASH, IDLE_ROWS)
    await expect(direct.result).resolves.toBe(false)
    expect(direct.readIdentityTable).not.toHaveBeenCalled()

    const powershell = confirm('powershell.exe', IDLE_ROWS)
    await expect(powershell.result).resolves.toBe(false)
    expect(powershell.readIdentityTable).not.toHaveBeenCalled()
  })

  it('confirms a launcher alone in its job without reading the table', async () => {
    const alone = confirm(LAUNCHER, [bash(LAUNCHER_PID, 50)])
    await expect(alone.result).resolves.toBe(true)
    expect(alone.readIdentityTable).not.toHaveBeenCalled()
  })

  it('fails closed when the process table cannot be read', async () => {
    await expect(confirm(LAUNCHER, new Error('snapshot unavailable')).result).resolves.toBe(false)
  })

  it('refutes a job that does not contain the launcher', async () => {
    await expect(confirm(LAUNCHER, IDLE_ROWS, [EXEC_STUB_PID, SHELL_PID]).result).resolves.toBe(
      false
    )
  })
})
