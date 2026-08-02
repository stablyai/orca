/**
 * Memory-leak regression: AgentDetector must not resurrect a PTY's record after exit.
 *
 * `onData` does a get-or-create + `this.ptys.set(ptyId, record)` BEFORE the
 * `if (record.state === 'stopped') return` guard. `onExit` DELETES the record from
 * all three ptyId-keyed maps rather than leaving a 'stopped' tombstone. So a data
 * chunk delivered AFTER onExit (the real exit-then-data race in pty.ts shutdown —
 * provider data still flows because finishPtyShutdown doesn't unsubscribe the data
 * handler) re-inserts a fresh 'unknown' record and re-seeds the scan-tail maps that
 * nothing will ever delete. ptyId is a fresh per-spawn UUID — unbounded over a session.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentDetector } from './agent-detector'

function oscTitle(title: string): string {
  return `\x1b]0;${title}\x07`
}

function makeStats() {
  return { onAgentStart: vi.fn(), onAgentStop: vi.fn() }
}

describe('AgentDetector refuses post-exit resurrection (leak regression)', () => {
  it('ignores a data chunk that arrives after the PTY has exited', () => {
    const stats = makeStats()
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('✳ Claude Code'), 100) // start
    detector.onExit('pty-1') // delete all per-pty records
    detector.onData('pty-1', oscTitle('✳ Claude Code'), 200) // late post-exit chunk

    // The post-exit chunk must NOT resurrect the record into a second session.
    expect(stats.onAgentStart).toHaveBeenCalledTimes(1)
    // And no per-pty record should linger.
    expect(detector.trackedPtyCount).toBe(0)
  })

  it('does not accumulate records across many exit-then-late-data races', () => {
    const stats = makeStats()
    const detector = new AgentDetector(stats as never)

    for (let i = 0; i < 200; i++) {
      const ptyId = `pty-${i}`
      detector.onData(ptyId, oscTitle('✳ Claude Code'), i * 10)
      detector.onExit(ptyId)
      detector.onData(ptyId, oscTitle('✳ Claude Code'), i * 10 + 1) // late chunk
    }

    expect(detector.trackedPtyCount).toBe(0)
  })

  it('still starts a fresh PTY whose id was never exited (guards over-blocking)', () => {
    const stats = makeStats()
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-A', oscTitle('✳ Claude Code'), 100)
    detector.onExit('pty-A')
    // A DIFFERENT, never-exited PTY must still start normally.
    detector.onData('pty-B', oscTitle('✳ Claude Code'), 200)

    expect(stats.onAgentStart).toHaveBeenCalledTimes(2)
    expect(detector.trackedPtyCount).toBe(1) // only the live pty-B is tracked
  })
})
