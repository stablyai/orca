import { describe, expect, it, vi } from 'vitest'
import { killDaemonPtyFenced, type DaemonPtyFencedKillDeps } from './daemon-pty-fenced-kill'

function deps(requestKill: DaemonPtyFencedKillDeps['requestKill']): DaemonPtyFencedKillDeps {
  return {
    supportsFencedTermination: () => true,
    withHistorySpawnLock: (_id, run) => run(),
    sessionIncarnation: () => 'inc-a',
    ensureConnected: async () => {},
    requestKill,
    completeShutdownWithHistoryLock: async () => {}
  }
}

const request = {
  id: 'pty-a',
  expectedIncarnationId: 'inc-a',
  requireNoAgentOwner: true,
  requireUnattached: false
}

describe('daemon fenced kill', () => {
  it('writes no kill when the caller revokes after the lock and connection waits', async () => {
    const requestKill = vi.fn(async () => ({ outcome: 'ended' }))
    await expect(
      killDaemonPtyFenced(deps(requestKill), request, { beforeRequest: () => false })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
    expect(requestKill).not.toHaveBeenCalled()
  })

  it('writes the kill when the grant still stands', async () => {
    const requestKill = vi.fn(async () => ({ outcome: 'ended', writersExited: true }))
    await expect(
      killDaemonPtyFenced(deps(requestKill), request, { beforeRequest: () => true })
    ).resolves.toEqual({ outcome: 'ended', writersExited: true })
    expect(requestKill).toHaveBeenCalledTimes(1)
  })
})
