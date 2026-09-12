import { describe, expect, it } from 'vitest'
import type { DaemonAuditObservation } from './daemon-audit-classifier'
import { notifyDaemonAuditListeners } from './notify-daemon-audit-listeners'
import { DaemonPtyRuntimeState, type DaemonIdentityChangeEvent } from './daemon-pty-runtime-state'

// Reaches the protected arrays through the real notifier, so the assertions observe the
// registration state the adapter actually publishes from rather than a stand-in list.
class RuntimeStateProbe extends DaemonPtyRuntimeState {
  protected observeAuditFailure(): void {}

  fireIdentityChange(event: DaemonIdentityChangeEvent): void {
    notifyDaemonAuditListeners(this.identityChangeListeners, event)
  }

  fireAuditObservation(observation: DaemonAuditObservation): void {
    notifyDaemonAuditListeners(this.auditObservationListeners, observation)
  }
}

const identity = { pid: 1, startedAtMs: 2, launchNonce: 'n' }
const identityEvent: DaemonIdentityChangeEvent = { previous: identity, current: identity }
const observation = {
  state: 'present',
  reason: 'authenticated_inventory'
} as DaemonAuditObservation

const newProbe = (): RuntimeStateProbe =>
  new RuntimeStateProbe({ socketPath: '/tmp/probe.sock', tokenPath: '/tmp/probe.token' })

describe('DaemonPtyRuntimeState listener disposal', () => {
  it('unsubscribes only the identity listener that asked, and repeats are a no-op', () => {
    const probe = newProbe()
    const seen: string[] = []
    const unsubscribeFirst = probe.onDaemonIdentityChanged(() => seen.push('first'))
    probe.onDaemonIdentityChanged(() => seen.push('second'))

    unsubscribeFirst()
    probe.fireIdentityChange(identityEvent)
    expect(seen).toEqual(['second'])

    // A repeat unsubscribe finds indexOf === -1; an unguarded splice would evict 'second'.
    unsubscribeFirst()
    probe.fireIdentityChange(identityEvent)
    expect(seen).toEqual(['second', 'second'])
  })

  it('unsubscribes only the audit listener that asked, and repeats are a no-op', () => {
    const probe = newProbe()
    const seen: string[] = []
    const unsubscribeFirst = probe.onAuditEligibilityObservation(() => seen.push('first'))
    probe.onAuditEligibilityObservation(() => seen.push('second'))

    unsubscribeFirst()
    probe.fireAuditObservation(observation)
    expect(seen).toEqual(['second'])

    unsubscribeFirst()
    probe.fireAuditObservation(observation)
    expect(seen).toEqual(['second', 'second'])
  })
})
