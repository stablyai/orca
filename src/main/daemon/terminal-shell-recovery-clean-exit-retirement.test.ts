import { describe, expect, it, vi } from 'vitest'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'

const CLEAN_EXIT = '\x1b[?1049hTUI\x1b[?1049l\x1b]133;D;0\x07'

function passthrough(data: string, rawStartSeq = 0): PtyIngressEmission {
  return { data, rawStartSeq, rawEndSeq: rawStartSeq + data.length, transformed: false }
}

function createBarrier(confirm: () => Promise<boolean>, maxPendingMs?: number) {
  const released: string[] = []
  const barrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: confirm,
    release: (emission) => released.push(emission.data),
    isAlive: () => true,
    ...(maxPendingMs !== undefined ? { maxPendingMs } : {})
  })
  return Object.assign(barrier, { released })
}

describe('clean-exit confirmation retirement', () => {
  it('retires a hung clean-exit proof so a later candidate can still prove ownership', async () => {
    let calls = 0
    const barrier = createBarrier(() => {
      calls += 1
      return calls === 1 ? new Promise(() => {}) : Promise.resolve(true)
    }, 20)

    barrier.accept(passthrough(CLEAN_EXIT))
    expect(calls).toBe(1)
    await barrier.awaitProofSettled()
    expect(barrier.getOwner()).toBeUndefined()

    barrier.accept(passthrough(CLEAN_EXIT, CLEAN_EXIT.length))
    await vi.waitFor(() => expect(calls).toBe(2))
    await barrier.awaitProofSettled()
    expect(barrier.getOwner()).toBe('shell')
  })

  it('contains a synchronously throwing confirm without wedging later candidates', async () => {
    let calls = 0
    const barrier = createBarrier(() => {
      calls += 1
      if (calls === 1) {
        throw new Error('sync boom')
      }
      return Promise.resolve(true)
    })

    expect(() => barrier.accept(passthrough(CLEAN_EXIT))).not.toThrow()
    await barrier.awaitProofSettled()
    expect(barrier.getOwner()).toBeUndefined()

    barrier.accept(passthrough(CLEAN_EXIT, CLEAN_EXIT.length))
    await vi.waitFor(() => expect(calls).toBe(2))
    await barrier.awaitProofSettled()
    expect(barrier.getOwner()).toBe('shell')
  })

  it('flushPending releases every byte of an episode storm past the rescan bound', () => {
    const barrier = createBarrier(() => new Promise(() => {}))
    const episode = '\x1b[?1049hT\x1b]133;D;1\x07x'
    const storm = episode.repeat(40)
    barrier.accept(passthrough(storm))
    barrier.flushPending()

    // Past the 16-pass rescan bound the remainder is released verbatim; the
    // bound trades scanner-model fidelity at teardown, never bytes.
    expect(barrier.released.join('')).toBe(storm)
  })
})
