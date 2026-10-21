import { describe, expect, it } from 'vitest'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import {
  inspectDaemonRecordProcess,
  readTerminalDaemonLiveness,
  type DaemonLivenessDependencies
} from './daemon-liveness-report'

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

function deps(overrides: Partial<DaemonLivenessDependencies>): DaemonLivenessDependencies {
  return {
    endpoint: () => ({ socketPath: '/run/d.sock', tokenPath: '/run/d.token' }),
    checkHealth: async () => ({ verdict: 'healthy', coverage: 'pty-spawn' }),
    readRecord: () => record,
    inspectPid: async () => 'live',
    confirmCeiling: (state) => state,
    ...overrides
  }
}

describe('terminal daemon liveness report', () => {
  it('is live with the ceiling when the daemon answers', async () => {
    await expect(readTerminalDaemonLiveness(deps({}))).resolves.toEqual({
      verdict: 'live',
      pid: 4288,
      detail: 'it answered its health check',
      processCeiling: record.processCeiling
    })
  })

  it('is exited after a kill -9, before anything respawns it', async () => {
    const report = await readTerminalDaemonLiveness(
      deps({
        checkHealth: async () => ({ verdict: 'unreachable', coverage: 'pty-spawn' }),
        inspectPid: async () => 'exited'
      })
    )
    expect(report.verdict).toBe('exited')
    expect(report.processCeiling).toBeNull()
  })

  it('is unverifiable, never exited, when a silent pid still runs or cannot be checked', async () => {
    for (const state of ['live', 'unverifiable'] as const) {
      const report = await readTerminalDaemonLiveness(
        deps({
          checkHealth: async () => ({ verdict: 'unreachable', coverage: 'pty-spawn' }),
          inspectPid: async () => state
        })
      )
      expect(report.verdict).toBe('unverifiable')
    }
    const noRecord = await readTerminalDaemonLiveness(
      deps({
        checkHealth: async () => ({ verdict: 'unreachable', coverage: 'pty-spawn' }),
        readRecord: () => null
      })
    )
    expect(noRecord.verdict).toBe('unverifiable')
  })

  it('is unverifiable on a server with no daemon provider', async () => {
    const report = await readTerminalDaemonLiveness(deps({ endpoint: () => null }))
    expect(report.verdict).toBe('unverifiable')
  })

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
