import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'
import { recordAuthenticatedInventory, type DaemonAuditContext } from './daemon-audit-classifier'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { trackDaemonAuditEligibility } from './daemon-audit-eligibility-event'

const context: DaemonAuditContext = {
  protocolGeneration: 23,
  provider: 'local-daemon',
  endpoint: '/profile/daemon.sock',
  tokenPath: '/profile/daemon.token',
  endpointKind: 'unix-socket',
  profileScope: '/profile'
}

beforeEach(() => {
  trackMock.mockReset()
})

describe('daemon audit eligibility telemetry', () => {
  it('uses a dedicated validator-accepted event family', () => {
    trackDaemonAuditEligibility(recordAuthenticatedInventory(context, null))

    expect(trackMock).toHaveBeenCalledOnce()
    const [name, props] = trackMock.mock.calls[0]
    expect(name).toBe('daemon_audit_eligibility')
    expect(name).not.toBe('daemon_lifecycle')
    expect(props).toMatchObject({
      state: 'present',
      reason: 'authenticated_inventory',
      evidence_sources: ['authenticated_inventory'],
      protocol_generation: 23,
      exact_incarnation: 'unavailable',
      process_reason: null
    })
    expect(validate('daemon_audit_eligibility', props).ok).toBe(true)
  })

  it('cannot affect callers when telemetry throws', () => {
    trackMock.mockImplementation(() => {
      throw new Error('transport failed')
    })

    expect(() =>
      trackDaemonAuditEligibility(recordAuthenticatedInventory(context, null))
    ).not.toThrow()
  })
})
