import { expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { terminatePtyJobAndReport } from './windows-pty-job-termination-report'
import type { WindowsProcessIdentityRow } from './windows-process-table'
import type { JobTerminationOutcome } from './windows-pty-job'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the report only passes proc to the injected readMembers and terminate fakes.
const proc = { pid: 10 } as unknown as IPty
const row = (pid: number, name: string, creationTimeMs?: number): WindowsProcessIdentityRow => ({
  pid,
  ppid: 1,
  name,
  ...(creationTimeMs === undefined ? {} : { creationTimeMs })
})

function deps(tables: WindowsProcessIdentityRow[][], members = [10, 20]) {
  const readTable = vi.fn()
  for (const table of tables) {
    readTable.mockResolvedValueOnce(table)
  }
  return {
    platform: 'win32' as const,
    startTimeAvailable: () => true,
    readTable,
    readMembers: () => new Set(members),
    terminate: vi.fn((): JobTerminationOutcome => 'terminated')
  }
}

const shellAndAgent = [row(10, 'pwsh.exe', 1000), row(20, 'claude.exe', 2000)]

it('ends the job and reports every member it read', async () => {
  const d = deps([shellAndAgent])
  expect(await terminatePtyJobAndReport(proc, { wslDistro: null }, d)).toEqual({
    terminated: true,
    identities: [
      { pid: 10, startTime: '1000' },
      { pid: 20, startTime: '2000' }
    ]
  })
  expect(d.terminate).toHaveBeenCalledOnce()
})

it('refuses WSL panes and wsl.exe members without ending the job', async () => {
  const wslPane = deps([shellAndAgent])
  expect(await terminatePtyJobAndReport(proc, { wslDistro: 'Ubuntu' }, wslPane)).toEqual({
    terminated: false
  })
  const wslMember = deps([[row(10, 'pwsh.exe', 1000), row(20, 'WSL.EXE', 2000)]])
  expect(await terminatePtyJobAndReport(proc, { wslDistro: null }, wslMember)).toEqual({
    terminated: false
  })
  expect(wslPane.terminate).not.toHaveBeenCalled()
  expect(wslMember.terminate).not.toHaveBeenCalled()
})

it('re-reads a member that started after the table read', async () => {
  const d = deps([[row(10, 'pwsh.exe', 1000)], shellAndAgent])
  expect(await terminatePtyJobAndReport(proc, { wslDistro: null }, d)).toMatchObject({
    terminated: true
  })
  expect(d.readTable).toHaveBeenCalledTimes(2)
})

it('reports nothing when the job could not be ended', async () => {
  const d = deps([shellAndAgent])
  d.terminate.mockReturnValue('unavailable')
  expect(await terminatePtyJobAndReport(proc, { wslDistro: null }, d)).toEqual({
    terminated: false
  })
})
