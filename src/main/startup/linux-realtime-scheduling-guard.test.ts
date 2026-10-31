import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, recordCrashBreadcrumb } = vi.hoisted(() => ({
  runProcess: vi.fn(async () => ({ code: 0 })),
  recordCrashBreadcrumb: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({ recordCrashBreadcrumb }))

import { refuseRealtimeSchedulingUnderZeroRtTime } from './linux-realtime-scheduling-guard'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-rtprio-'))
  runProcess.mockClear()
  recordCrashBreadcrumb.mockClear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function procLimits(rtPrio: string, rtTime: string): string {
  const path = join(dir, 'limits')
  writeFileSync(
    path,
    [
      'Limit                     Soft Limit           Hard Limit           Units     ',
      `Max realtime priority     ${rtPrio.padEnd(21)}${rtPrio.padEnd(21)}`,
      `Max realtime timeout      ${rtTime.padEnd(21)}${rtTime.padEnd(21)}us        `,
      ''
    ].join('\n')
  )
  return path
}

describe('refuseRealtimeSchedulingUnderZeroRtTime', () => {
  it('zeroes RLIMIT_RTPRIO on this process when the RTTIME limit is 0 and realtime is allowed', async () => {
    await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'))
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'prlimit',
        args: ['--pid', String(process.pid), '--rtprio=0:0']
      })
    )
    expect(recordCrashBreadcrumb).toHaveBeenCalledWith('linux_rttime_limit', {
      soft: '0',
      hard: '0',
      rtPrio: 'lowered'
    })
  })

  it.each([
    ['exits nonzero', () => runProcess.mockResolvedValueOnce({ code: 1 })],
    ['is missing', () => runProcess.mockRejectedValueOnce(new Error('spawn prlimit ENOENT'))]
  ])(
    'reports a failure instead of claiming the tree was lowered when prlimit %s',
    async (_case, arrange) => {
      arrange()
      await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'))
      expect(recordCrashBreadcrumb).toHaveBeenCalledWith(
        'linux_rttime_limit',
        expect.objectContaining({ rtPrio: 'prlimit-failed' })
      )
    }
  )

  it.each([
    ['realtime is already disallowed', '0', '0', 1],
    ['the RTTIME limit is not zero', '95', 'unlimited', 0]
  ])('leaves limits alone when %s', async (_case, rtPrio, rtTime, breadcrumbs) => {
    await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits(rtPrio, rtTime))
    expect(runProcess).not.toHaveBeenCalled()
    expect(recordCrashBreadcrumb).toHaveBeenCalledTimes(breadcrumbs)
  })
})
