/* The gate on the shared retirement fan-out. Every other case in this area drives a daemon that
 * reports incarnations, and there `clearForLiveSession` already keeps a certificate the live run
 * itself issued — so removing this gate reddens nothing over that protocol. The population it
 * actually stands for is the other one: a daemon too old to name a run, where retirement is an
 * unconditional delete and this gate is the only thing between a watched death and
 * `unverifiable`. */
import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { retireSpawnedSessionExitCertificates } from './daemon-spawn-exit-certificate-retirement'

function recordingAdapters(count: number): {
  adapters: DaemonPtyAdapter[]
  retirements: ReturnType<typeof vi.fn>[]
} {
  const retirements = Array.from({ length: count }, () => vi.fn())
  return {
    adapters: retirements.map(
      (retireExitCertificate) => ({ retireExitCertificate }) as unknown as DaemonPtyAdapter
    ),
    retirements
  }
}

describe('the shared spawn retirement fan-out', () => {
  it('names the run now live to every generation that could hold the reused id', () => {
    const { adapters, retirements } = recordingAdapters(2)

    retireSpawnedSessionExitCertificates(adapters, {
      id: 'wt-1::/repo@@abc',
      incarnationId: 'inc-2',
      pid: null
    })

    for (const retirement of retirements) {
      expect(retirement).toHaveBeenCalledWith('wt-1::/repo@@abc', 'inc-2')
    }
  })

  it('withholds retirement from a spawn that reports the pty died before its reply', () => {
    // No incarnation on either side, which is the case the retirement itself cannot
    // discriminate: it would delete the certificate this very spawn's death just earned, and
    // that certificate is the only record, because such a spawn establishes no route.
    const { adapters, retirements } = recordingAdapters(2)

    retireSpawnedSessionExitCertificates(adapters, {
      id: 'wt-1::/repo@@abc',
      pid: null,
      exitedBeforeSpawnReply: true
    })

    for (const retirement of retirements) {
      expect(retirement).not.toHaveBeenCalled()
    }
  })
})
