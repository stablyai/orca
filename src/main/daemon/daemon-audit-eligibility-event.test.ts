import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'
import { recordAuthenticatedInventory, type DaemonAuditContext } from './daemon-audit-classifier'
import type { ExactDaemonIncarnation } from './daemon-incarnation-evidence'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))

import {
  createDaemonAuditEligibilityTracker,
  trackDaemonAuditEligibility
} from './daemon-audit-eligibility-event'

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
      generation_role: 'legacy',
      exact_incarnation: 'unavailable',
      process_reason: null
    })
    expect(props).not.toHaveProperty('exact_incarnation_correlation')
    expect(validate('daemon_audit_eligibility', props).ok).toBe(true)
  })

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

  it('does not mislabel a future protocol generation as legacy', () => {
    const trackEligibility = createDaemonAuditEligibilityTracker()

    expect(() =>
      trackEligibility(
        recordAuthenticatedInventory(
          { ...context, protocolGeneration: PROTOCOL_VERSION + 1 },
          exactIncarnation
        )
      )
    ).not.toThrow()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('cannot affect callers when telemetry throws', () => {
    trackMock.mockImplementation(() => {
      throw new Error('transport failed')
    })

    expect(() =>
      trackDaemonAuditEligibility(recordAuthenticatedInventory(context, null))
    ).not.toThrow()

    // The rate-limited tracker is the production call site, so it carries the same guarantee.
    const trackEligibility = createDaemonAuditEligibilityTracker()
    expect(() => trackEligibility(recordAuthenticatedInventory(context, null))).not.toThrow()
  })

  it('cannot affect callers when the rate-limit bookkeeping throws', () => {
    const trackEligibility = createDaemonAuditEligibilityTracker(() => {
      throw new Error('no clock')
    })

    expect(() => trackEligibility(recordAuthenticatedInventory(context, null))).not.toThrow()

    // A malformed observation must not escape the guard either.
    const malformed = recordAuthenticatedInventory(context, null)
    expect(() =>
      trackEligibility({ ...malformed, evidenceSources: undefined as never })
    ).not.toThrow()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('collapses repeated identical observations into one heartbeat per window', () => {
    let nowMs = 1_700_000_000_000
    const trackEligibility = createDaemonAuditEligibilityTracker(() => nowMs)

    for (let index = 0; index < 60; index += 1) {
      nowMs += 1_000
      trackEligibility(recordAuthenticatedInventory(context, exactIncarnation))
    }

    expect(trackMock).toHaveBeenCalledOnce()

    nowMs += 5 * 60_000
    trackEligibility(recordAuthenticatedInventory(context, exactIncarnation))
    expect(trackMock).toHaveBeenCalledTimes(2)
  })

  it('keeps heartbeating after the clock jumps backward', () => {
    let nowMs = 1_700_000_000_000
    const trackEligibility = createDaemonAuditEligibilityTracker(() => nowMs)

    trackEligibility(recordAuthenticatedInventory(context, null))
    expect(trackMock).toHaveBeenCalledOnce()

    // An NTP correction / VM resume rewinds the clock by an hour.
    nowMs -= 60 * 60_000
    trackEligibility(recordAuthenticatedInventory(context, null))
    expect(trackMock).toHaveBeenCalledTimes(2)

    // The window re-anchors on the rewound clock instead of emitting on every call.
    for (let index = 0; index < 60; index += 1) {
      nowMs += 1_000
      trackEligibility(recordAuthenticatedInventory(context, null))
    }
    expect(trackMock).toHaveBeenCalledTimes(2)

    nowMs += 5 * 60_000
    trackEligibility(recordAuthenticatedInventory(context, null))
    expect(trackMock).toHaveBeenCalledTimes(3)
  })

  it('measures the window on a monotonic clock rather than wall time', () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const trackEligibility = createDaemonAuditEligibilityTracker()

    try {
      trackEligibility(recordAuthenticatedInventory(context, null))
      expect(trackMock).toHaveBeenCalledOnce()

      // Wall time alone must not open the window: no real time has elapsed.
      wallClock.mockReturnValue(1_700_000_000_000 + 6 * 60_000)
      trackEligibility(recordAuthenticatedInventory(context, null))
      expect(trackMock).toHaveBeenCalledOnce()
    } finally {
      wallClock.mockRestore()
    }
  })

  it('emits immediately when the observation changes', () => {
    let nowMs = 1_700_000_000_000
    const trackEligibility = createDaemonAuditEligibilityTracker(() => nowMs)

    trackEligibility(recordAuthenticatedInventory(context, null))
    nowMs += 1_000
    trackEligibility(
      recordAuthenticatedInventory(context, {
        identity: { pid: 42, startedAtMs: nowMs, launchNonce: 'launch-a' }
      })
    )

    expect(trackMock).toHaveBeenCalledTimes(2)
    expect(trackMock.mock.calls[1][1]).toMatchObject({ exact_incarnation: 'endpoint-identity' })
  })
})

describe('daemon audit eligibility inventory volume', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-audit-eligibility-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not emit one eligibility event per successful inventory', async () => {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => {
        throw new Error('Test must not create a PTY')
      }
    })
    await server.start()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath })

    for (let index = 0; index < 40; index += 1) {
      await adapter.listProcesses()
    }

    expect(
      trackMock.mock.calls.filter(([name]) => name === 'daemon_audit_eligibility')
    ).toHaveLength(1)
  })
})
