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
  }
)
