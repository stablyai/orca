import { describe, expect, it, vi } from 'vitest'
import {
  findOrphanedTccLogStreams,
  reclaimOrphanedTccLogStreams
} from './macos-tcc-log-stream-orphans'
import { parsePsArgsLine, type ProcessIdentityRow } from '../opencode/opencode-client-sweep'

// Captured from `ps -eo pid=,ppid=,etime=,args=` on a Mac holding leaked watchers.
const LEGACY_ARGS =
  '/usr/bin/log stream --predicate subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING" --info --style compact'

function row(
  pid: number,
  ppid: number,
  args = LEGACY_ARGS,
  executable = '/usr/bin/log'
): ProcessIdentityRow {
  const parsed = parsePsArgsLine(`${pid} ${ppid} 01:00 ${args}`, Date.now())
  if (!parsed) {
    throw new Error('unparseable fixture')
  }
  return { ...parsed, executable }
}

describe('findOrphanedTccLogStreams', () => {
  it('matches only launchd-parented copies of the exact watcher command', () => {
    expect(
      findOrphanedTccLogStreams([
        row(10, 1),
        row(11, 4321),
        row(12, 1, '/usr/bin/log stream --predicate subsystem == "com.apple.TCC" --style compact'),
        row(13, 1, '/usr/bin/log show --last 1m'),
        // Simulate PID reuse between argv and executable snapshots, plus unreadable executable identity.
        row(14, 1, LEGACY_ARGS, '/usr/bin/yes'),
        row(15, 1, LEGACY_ARGS, '')
      ]).map((match) => match.pid)
    ).toEqual([10])
  })
})

describe('reclaimOrphanedTccLogStreams', () => {
  it('skips a pid whose identity changed or cannot be re-read before signalling', async () => {
    const kill = vi.fn()
    const restarted = { ...row(42, 1), startedAtMs: Date.now() + 60_000 }
    const current = new Map<number, ProcessIdentityRow | null>([
      [40, null],
      [41, row(41, 1, '/usr/bin/log stream --style compact')],
      [42, restarted],
      [43, row(43, 777)]
    ])
    const reclaimed = await reclaimOrphanedTccLogStreams({
      platform: 'darwin',
      sweep: async () => [row(40, 1), row(41, 1), row(42, 1), row(43, 1)],
      readProcess: async (pid) => current.get(pid) ?? null,
      kill
    })
    expect(kill).not.toHaveBeenCalled()
    expect(reclaimed).toBe(0)
  })
})
