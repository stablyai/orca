import { expect, it } from 'vitest'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime,
  readWindowsProcessTableFresh
} from './windows-process-table'

it.runIf(process.platform === 'win32')(
  'reads creation times from the real Windows process-tree addon',
  async () => {
    expect(isWindowsProcessStartTimeAvailable()).toBe(true)

    const rows = await readWindowsProcessTableFresh()
    const rowsWithCreationTime = rows.filter((row) => typeof row.creationTimeMs === 'number').length
    expect(rowsWithCreationTime).toBeGreaterThan(0)

    // Our own creation time must exist and fall in Unix-ms bounds; counts cannot detect raw FILETIME/ticks.
    const self = rows.find((row) => row.pid === process.pid)
    expect(typeof self?.creationTimeMs).toBe('number')
    expect(self?.creationTimeMs).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'))
    expect(self?.creationTimeMs).toBeLessThanOrEqual(Date.now())
    expect(readWindowsProcessCreationTime(process.pid)).toBe(self?.creationTimeMs)
    expect(readWindowsProcessCreationTime(process.pid)).toBe(self?.creationTimeMs)
  }
)
