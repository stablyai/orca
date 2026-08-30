import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'

// Why: the POSIX reader wraps execFile with promisify, so the mock must honor
// the Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

const SCAN_AT_MS = 1_700_000_000_000

/** A cached snapshot that never contained the pane observed nothing about it:
 *  it must degrade (`available: false`) instead of reading as "no agent". */
describe('cached snapshot pane availability', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    resetProcessTableSnapshotForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('treats a cached snapshot containing none of the pane as unavailable', async () => {
    // Neither the shell row nor any direct child of it is in the table.
    mockPs('1 0 Ss /sbin/launchd')

    await expect(resolveAgentForegroundProcessWithAvailability(100, 'zsh')).resolves.toEqual({
      available: false,
      processName: 'zsh'
    })
  })

  it('still scans a cached snapshot that has the pane children but lost the shell row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(SCAN_AT_MS)
    mockPs('101 100 S+ node /Users/dev/.nvm/versions/node/bin/codex')

    try {
      await expect(resolveAgentForegroundProcessWithAvailability(100, 'node')).resolves.toEqual({
        available: true,
        processName: 'codex',
        // The scan's own start travels with the rows. A pane served this snapshot from
        // the shared cache asks later than this, so it must order the table by when the
        // table was read — its own clock would claim the rows are newer than they are.
        tableScanStartedAtMs: SCAN_AT_MS
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
