import '../../pty-subprocess/testing/mock-descendant-sweep'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../../../telemetry/validator'
import { recordAuthenticatedInventory, type DaemonAuditContext } from '../daemon-audit-classifier'
import type { ExactDaemonIncarnation } from '../../endpoint/identity/daemon-incarnation-evidence-types'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))
import { createDaemonAuditEligibilityTracker } from '../daemon-audit-eligibility-event'

const context: DaemonAuditContext = {
  protocolGeneration: 23,
  provider: 'local-daemon',
  endpoint: '/profile/daemon.sock',
  tokenPath: '/profile/daemon.token',
  endpointKind: 'unix-socket',
  profileScope: '/profile'
}

const exactIncarnation: ExactDaemonIncarnation = {
  identity: {
    pid: 92_847_561,
    startedAtMs: 1_786_000_123_456,
    launchNonce: 'private-launch-nonce'
  },
  linuxStartTicks: '8642097531',
  bootId: 'private-boot-id'
}

beforeEach(() => {
  trackMock.mockReset()
})

describe('daemon audit eligibility telemetry', () => {
  it('correlates an exact incarnation across app trackers without raw identity fields', () => {
    const currentContext = { ...context, protocolGeneration: PROTOCOL_VERSION }
    const firstAppTracker = createDaemonAuditEligibilityTracker()
    const secondAppTracker = createDaemonAuditEligibilityTracker()

    firstAppTracker(recordAuthenticatedInventory(currentContext, exactIncarnation))
    secondAppTracker(recordAuthenticatedInventory(currentContext, exactIncarnation))
    secondAppTracker(
      recordAuthenticatedInventory(currentContext, {
        ...exactIncarnation,
        identity: { ...exactIncarnation.identity, launchNonce: 'another-private-launch-nonce' }
      })
    )

    const firstProperties = trackMock.mock.calls[0][1]
    const secondProperties = trackMock.mock.calls[1][1]
    const replacementProperties = trackMock.mock.calls[2][1]
    expect(firstProperties).toMatchObject({
      generation_role: 'current',
      exact_incarnation: 'endpoint-identity-linux-ticks',
      exact_incarnation_correlation: 'v1:2751326d0f457808fe11a03ce2f6e732'
    })
    expect(secondProperties.exact_incarnation_correlation).toBe(
      firstProperties.exact_incarnation_correlation
    )
    expect(replacementProperties.exact_incarnation_correlation).not.toBe(
      firstProperties.exact_incarnation_correlation
    )
    expect(validate('daemon_audit_eligibility', firstProperties).ok).toBe(true)

    const serializedProperties = JSON.stringify(firstProperties)
    for (const rawIdentity of [
      exactIncarnation.identity.launchNonce,
      String(exactIncarnation.identity.pid),
      String(exactIncarnation.identity.startedAtMs),
      exactIncarnation.linuxStartTicks,
      exactIncarnation.bootId
    ]) {
      expect(serializedProperties).not.toContain(rawIdentity)
    }
  })
})
