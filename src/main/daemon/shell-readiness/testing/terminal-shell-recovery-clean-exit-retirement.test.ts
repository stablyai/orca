import { describe, expect, it } from 'vitest'
import { TerminalShellRecoveryBarrier } from '../terminal-shell-recovery-barrier'
import type { PtyIngressEmission } from '../../../../shared/terminal/pty/ingress/pty-startup-ingress-contract'

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
  it('flushPending releases every byte of an episode storm past the rescan bound', () => {
    const barrier = createBarrier(() => new Promise(() => {}))
    const episode = '\x1b[?1049hT\x1b]133;D;1\x07x'
    const storm = episode.repeat(40)
    barrier.accept(passthrough(storm))
    barrier.flushPending()

    // The rescan bound may sacrifice scanner state during teardown, but must preserve every byte.
    expect(barrier.released.join('')).toBe(storm)
  })
})
