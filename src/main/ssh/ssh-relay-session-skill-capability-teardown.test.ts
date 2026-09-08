import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDeps } from './ssh-relay-session-test-fixtures'
import type * as SkillDiscoveryTarget from '../skills/skill-discovery-target'

const { forgetCapabilitiesMock } = vi.hoisted(() => ({ forgetCapabilitiesMock: vi.fn() }))

vi.mock('../skills/skill-discovery-target', async (importOriginal) => ({
  ...(await importOriginal<typeof SkillDiscoveryTarget>()),
  forgetSshSkillDiscoveryCapabilities: forgetCapabilitiesMock
}))

import { SshRelaySession } from './ssh-relay-session'

/**
 * Pins the *call site*, not the helper. The helper has its own unit test, but a
 * memoized capability answer that outlives its relay is what makes "Reconnect
 * this SSH host to enable skills" permanent — the user reconnects, deploys a
 * relay that does support discovery, and is told to reconnect again. That only
 * stays fixed while something actually invokes the invalidator on teardown.
 */
describe('SshRelaySession skill-capability teardown', () => {
  beforeEach(() => forgetCapabilitiesMock.mockReset())

  function session(targetId: string) {
    const deps = createMockDeps()
    return new SshRelaySession(
      targetId,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    ) as unknown as {
      teardownProviders: (reason: 'shutdown' | 'connection_lost') => void
    }
  }

  it('forgets the connection memoized relay capabilities on shutdown', () => {
    session('target-1').teardownProviders('shutdown')

    expect(forgetCapabilitiesMock).toHaveBeenCalledWith('target-1')
  })

  // Why both reasons: a dropped connection is the case that precedes a
  // reconnect, so it is the one that must not carry stale capabilities forward.
  it('forgets them when the connection is lost, not only on a clean shutdown', () => {
    session('target-2').teardownProviders('connection_lost')

    expect(forgetCapabilitiesMock).toHaveBeenCalledWith('target-2')
  })
})
