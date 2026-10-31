import { expect, it } from 'vitest'
import {
  readWindowsProcessCreationTime,
  readWindowsProcessTableFresh
} from '../windows/windows-process-table'
import {
  captureWindowsPaneAgentStop,
  windowsPaneAgentStopAvailable
} from './windows-pane-agent-stop'

it.runIf(process.platform === 'win32')(
  'requires the built Windows addon to supply fresh birth identities for selective stop',
  async () => {
    expect(windowsPaneAgentStopAvailable()).toBe(true)
    const rows = await readWindowsProcessTableFresh()
    const self = rows.find((row) => row.pid === process.pid)
    expect(self?.creationTimeMs).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'))
    expect(self?.creationTimeMs).toBeLessThanOrEqual(Date.now())
    expect(readWindowsProcessCreationTime(process.pid)).toBe(self?.creationTimeMs)
    expect(readWindowsProcessCreationTime(0)).toBeNull()
    // A missing pane cannot become a stop target even with an otherwise usable native binding.
    expect(
      await captureWindowsPaneAgentStop({
        rootPid: 0,
        agent: 'claude',
        ptyId: 'missing',
        incarnationId: 'missing'
      })
    ).toBeNull()
  }
)
