import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, recordCrashBreadcrumb } = vi.hoisted(() => ({
  runProcess: vi.fn(async (_options: { args: string[] }) => ({ code: 0 })),
  recordCrashBreadcrumb: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb
}))

import {
  listProcessTree,
  refuseRealtimeSchedulingUnderZeroRtTime
} from './linux-realtime-scheduling-guard'
import { getStartupRtPrioOutcome, setStartupRtPrioOutcome } from './linux-rttime-limit'

let dir: string
let procRoot: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-rtprio-'))
  procRoot = join(dir, 'proc')
  runProcess.mockClear()
  recordCrashBreadcrumb.mockClear()
  setStartupRtPrioOutcome(null)
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

// children === null models a live thread whose children file can't be read.
function fakeThread(pid: number, tid: number, children: string | null): void {
  const taskDir = join(procRoot, String(pid), 'task', String(tid))
  mkdirSync(taskDir, { recursive: true })
  if (children !== null) {
    writeFileSync(join(taskDir, 'children'), children)
  }
}

describe('listProcessTree', () => {
  it('walks children of every thread, breadth first', () => {
    fakeThread(100, 100, '200 ')
    fakeThread(100, 101, '300 ')
    fakeThread(200, 200, '400\n')
    fakeThread(300, 300, '')
    fakeThread(400, 400, '')
    expect(listProcessTree(100, procRoot)).toEqual({
      pids: [100, 200, 300, 400],
      complete: true
    })
  })

  it('ignores processes that exited before their task dir was read', () => {
    fakeThread(100, 100, '200 ')
    expect(listProcessTree(100, procRoot)).toEqual({
      pids: [100, 200],
      complete: true
    })
  })

  it('marks the walk incomplete when a live thread has no readable children list', () => {
    fakeThread(100, 100, null)
    expect(listProcessTree(100, procRoot)).toEqual({
      pids: [100],
      complete: false
    })
  })
})

describe('refuseRealtimeSchedulingUnderZeroRtTime', () => {
  it('zeroes RLIMIT_RTPRIO across the current process tree when RTTIME is 0 and realtime is allowed', async () => {
    fakeThread(process.pid, process.pid, '4242 ')
    fakeThread(4242, 4242, '')
    await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'), procRoot)
    expect(runProcess.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({
        program: 'prlimit',
        args: ['--pid', String(process.pid), '--rtprio=0:0']
      }),
      expect.objectContaining({
        program: 'prlimit',
        args: ['--pid', '4242', '--rtprio=0:0']
      })
    ])
    expect(recordCrashBreadcrumb).toHaveBeenCalledWith('linux_rttime_limit', {
      soft: '0',
      hard: '0',
      rtPrio: 'lowered'
    })
    // Process-gone reports read this after the startup breadcrumb has rotated out of the ring.
    expect(getStartupRtPrioOutcome()).toBe('lowered')
  })

  it('still reports lowered when a short-lived child exited before its prlimit ran', async () => {
    fakeThread(process.pid, process.pid, '4242 4343 ')
    fakeThread(4242, 4242, '')
    fakeThread(4343, 4343, '')
    runProcess.mockImplementation(async ({ args }) => {
      if (args[1] === '4343') {
        rmSync(join(procRoot, '4343'), { recursive: true, force: true })
        return { code: 1 }
      }
      return { code: 0 }
    })
    try {
      await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'), procRoot)
    } finally {
      runProcess.mockImplementation(async () => ({ code: 0 }))
    }
    expect(runProcess).toHaveBeenCalledTimes(3)
    expect(recordCrashBreadcrumb).toHaveBeenCalledWith(
      'linux_rttime_limit',
      expect.objectContaining({ rtPrio: 'lowered' })
    )
  })

  it('does not claim the tree was lowered when child processes could not be enumerated', async () => {
    fakeThread(process.pid, process.pid, null)
    await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'), procRoot)
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(recordCrashBreadcrumb).toHaveBeenCalledWith(
      'linux_rttime_limit',
      expect.objectContaining({ rtPrio: 'lowered-partial-tree' })
    )
  })

  it.each([
    ['exits nonzero', () => runProcess.mockResolvedValueOnce({ code: 1 })],
    ['is missing', () => runProcess.mockRejectedValueOnce(new Error('spawn prlimit ENOENT'))]
  ])(
    'reports a failure instead of claiming the tree was lowered when prlimit %s',
    async (_case, arrange) => {
      fakeThread(process.pid, process.pid, '')
      arrange()
      await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits('95', '0'), procRoot)
      expect(recordCrashBreadcrumb).toHaveBeenCalledWith(
        'linux_rttime_limit',
        expect.objectContaining({ rtPrio: 'prlimit-failed' })
      )
      expect(getStartupRtPrioOutcome()).toBe('prlimit-failed')
    }
  )

  it.each([
    ['realtime is already disallowed', '0', '0', 1],
    ['the RTTIME limit is not zero', '95', 'unlimited', 0]
  ])('leaves limits alone when %s', async (_case, rtPrio, rtTime, breadcrumbs) => {
    await refuseRealtimeSchedulingUnderZeroRtTime('linux', procLimits(rtPrio, rtTime), procRoot)
    expect(runProcess).not.toHaveBeenCalled()
    expect(recordCrashBreadcrumb).toHaveBeenCalledTimes(breadcrumbs)
  })

  it('does nothing off Linux', async () => {
    await refuseRealtimeSchedulingUnderZeroRtTime('darwin', procLimits('95', '0'), procRoot)
    expect(runProcess).not.toHaveBeenCalled()
    expect(recordCrashBreadcrumb).not.toHaveBeenCalled()
  })
})
