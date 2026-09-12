import { expect, it, vi } from 'vitest'
import type { SshRelaySession } from './ssh-relay-session'
import type { createMockDeps } from './ssh-relay-session-test-fixtures'

type Fixture = {
  session: SshRelaySession
  deps: ReturnType<typeof createMockDeps>
}

export function registerSuccessorRetirementSessionTests(
  prepareRecovery: (targetId: string) => Promise<Fixture>,
  clearPtyIds: () => void
): void {
  async function resumedFixture(targetId: string): Promise<Fixture> {
    const fixture = await prepareRecovery(targetId)
    clearPtyIds()
    fixture.deps.mockConn.getTransportGeneration = vi.fn(() => 17)
    await fixture.session.reconnect(fixture.deps.mockConn)
    return fixture
  }

  it('does not grant successor retirement from a fresh negotiated admission', async () => {
    const { session } = await prepareRecovery('successor-fresh-admission')
    expect(session.getState()).toBe('ready')
    expect(session.readSuccessorRetirementSession()).toBeNull()
    session.dispose()
  })

  it('returns the exact live resumed admission without putting resume evidence on the owner', async () => {
    const { session, deps } = await resumedFixture('successor-resumed-admission')
    const snapshot = session.readSuccessorRetirementSession()
    expect(snapshot).toEqual({
      targetId: 'successor-resumed-admission',
      mux: expect.any(Object),
      connection: deps.mockConn,
      transportGeneration: 17,
      owner: expect.objectContaining({ mode: 'negotiated', ownerGeneration: 2 }),
      resumed: true
    })
    expect(snapshot?.owner).not.toHaveProperty('resumed')
    expect(session.readSuccessorRetirementSession()?.owner).toBe(snapshot?.owner)
    expect(session.readSuccessorRetirementSession()?.mux).toBe(snapshot?.mux)
    session.dispose()
    expect(session.readSuccessorRetirementSession()).toBeNull()
  })

  it.each(['owner', 'mux', 'disposed-mux', 'state', 'connection'] as const)(
    'refuses successor retirement when the admitted %s is no longer current',
    async (changed) => {
      const { session } = await resumedFixture(`successor-stale-${changed}`)
      const snapshot = session.readSuccessorRetirementSession()!
      expect(snapshot).not.toBeNull()
      // Fault injection isolates each fence after a real mocked establish/reconnect admission.
      const internals = session as unknown as {
        ptyConsumerSessionState: typeof snapshot.owner
        mux: typeof snapshot.mux
        _state: string
        currentConnection: typeof snapshot.connection | null
      }
      if (changed === 'owner') {
        internals.ptyConsumerSessionState = { ...snapshot.owner }
      }
      if (changed === 'mux') {
        internals.mux = { ...snapshot.mux } as typeof snapshot.mux
      }
      if (changed === 'disposed-mux') {
        vi.mocked(snapshot.mux.isDisposed).mockReturnValue(true)
      }
      if (changed === 'state') {
        internals._state = 'reconnecting'
      }
      if (changed === 'connection') {
        internals.currentConnection = null
      }
      expect(session.readSuccessorRetirementSession()).toBeNull()
      internals.mux = snapshot.mux
      vi.mocked(snapshot.mux.isDisposed).mockReturnValue(false)
      session.dispose()
    }
  )
}
