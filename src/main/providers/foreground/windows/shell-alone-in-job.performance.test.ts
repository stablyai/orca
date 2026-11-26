import { expect, it } from 'vitest'
import { getProcessTableIndex } from '../../../../shared/process-observation/tables/process-table-index'
import { isWindowsShellAloneInJob } from './shell-alone-in-job'

it.each([
  [300, 600],
  [3_000, 6_000]
])('visits the parent links of %i Git Bash job members at most %i times', async (size, limit) => {
  const rootPid = 30_000
  let parentReads = 0
  const rows = Array.from({ length: size }, (_, index) => ({
    pid: rootPid + index,
    get ppid() {
      parentReads += 1
      return index === 0 ? 1 : rootPid + index - 1
    },
    name: 'bash.exe',
    creationTimeMs: index + 1
  }))
  const job = new Set(rows.map((row) => row.pid))
  getProcessTableIndex(rows)
  parentReads = 0

  await expect(
    isWindowsShellAloneInJob(
      rootPid,
      'C:\\Program Files\\Git\\bin\\bash.exe',
      job,
      async () => rows
    )
  ).resolves.toBe(true)
  expect(parentReads).toBeLessThanOrEqual(limit)
})
