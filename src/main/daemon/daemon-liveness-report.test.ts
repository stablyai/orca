import { describe, expect, it } from 'vitest'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import { inspectDaemonRecordProcess } from './daemon-liveness-report'

const record: ParsedDaemonPid = {
  pid: 4288,
  startedAtMs: null,
  entryPath: null,
  appVersion: null,
  launchNonce: null,
  linuxStartTicks: '777',
  bootId: 'b',
  spawnerExecPath: null,
  cgroupUnit: null,
  processCeiling: { state: 'on', limit: 200, mechanism: 'systemd-slice', unit: 'orca.slice' }
}

describe('terminal daemon liveness report', () => {
  it.runIf(process.platform === 'linux')(
    'reads a pid reused by another process as exited',
    async () => {
      await expect(
        inspectDaemonRecordProcess({ ...record, pid: process.pid, linuxStartTicks: '1' })
      ).resolves.toBe('exited')
    }
  )

  it('never reads a signal-live pid as exited because procfs hides its stat', async () => {
    await expect(
      inspectDaemonRecordProcess({ ...record, pid: process.pid }, 'linux', async () => ({
        status: 'missing'
      }))
    ).resolves.toBe('unverifiable')
  })

  it('reads a pid with no process as exited', async () => {
    await expect(inspectDaemonRecordProcess({ ...record, pid: 2 ** 22 + 12_345 })).resolves.toBe(
      'exited'
    )
    await expect(
      inspectDaemonRecordProcess({ ...record, pid: process.pid, linuxStartTicks: null })
    ).resolves.toBe('live')
  })
})
