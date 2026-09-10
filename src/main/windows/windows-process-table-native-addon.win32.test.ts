import { expect, it } from 'vitest'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessTableFresh
} from './windows-process-table'

it.runIf(process.platform === 'win32')(
  'reads creation times from the real Windows process-tree addon',
  async () => {
    expect(isWindowsProcessStartTimeAvailable()).toBe(true)

    const rows = await readWindowsProcessTableFresh()
    const rowsWithCreationTime = rows.filter((row) => typeof row.creationTimeMs === 'number').length
    expect(rowsWithCreationTime).toBeGreaterThan(0)

    // Why our own row and not merely a count: a single stray row satisfies a
    // count, and an addon that forwards the raw FILETIME satisfies it too. We
    // opened our own handle, so this row is the one the addon can never fail to
    // answer, and its value is bounded on both sides -- a 1601-epoch stamp lands
    // below the floor, an unconverted 100ns tick lands astronomically above now.
    const self = rows.find((row) => row.pid === process.pid)
    expect(typeof self?.creationTimeMs).toBe('number')
    expect(self?.creationTimeMs).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'))
    expect(self?.creationTimeMs).toBeLessThanOrEqual(Date.now())
  }
)
