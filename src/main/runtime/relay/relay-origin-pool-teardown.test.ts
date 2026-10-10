import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { RelayHostHelloAckMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'

const fakes = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an empty literal cannot infer the element type, and vi.hoisted runs before the class that fills it exists.
  controls: [] as {
    options: {
      onDrain(message: { type: 'drain'; graceMs: number; recovery: 'resolve-director' }): void
      onClose(code: number): void
    }
  }[],
  controlConnect: vi.fn(),
  exchange: vi.fn(),
  assign: vi.fn(),
  // Why mutable: a retiring origin only keeps its grace timer while something still answers
  // through it; at zero, maybeClose retires it on the spot and there is no timer left to survive.
  pendingRequestCount: 0
}))

vi.mock('./relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClientModule>()),
  exchangeRelayAuthorization: fakes.exchange,
  requestRelayAssignment: fakes.assign
}))

vi.mock('./relay-control-client', () => ({
  RelayControlClient: class {
    connect = fakes.controlConnect
    closeNow = vi.fn()
    isLive = vi.fn(() => true)
    get pendingRequestCount(): number {
      return fakes.pendingRequestCount
    }
    constructor(readonly options: (typeof fakes.controls)[number]['options']) {
      fakes.controls.push(this)
    }
  }
}))

vi.mock('../rpc/relay-transport', () => ({
  CloudRelayTransport: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = vi.fn()
    metadataFor = vi.fn()
    hasConnection = vi.fn(() => false)
    openConnection = vi.fn().mockResolvedValue(undefined)
  }
}))

import { RelaySessionBroker } from './relay-session-broker'

function brokerOptions(
  overrides: Partial<Parameters<typeof RelaySessionBroker.connect>[0]> = {}
): Parameters<typeof RelaySessionBroker.connect>[0] {
  const keypair = nacl.box.keyPair()
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RelaySessionBroker.connect reads only these two endpoints off authConfig; the rest of the profile config is never reached.
    authConfig: {
      relayTokenEndpoint: 'https://auth.example.test/v1/relay-token',
      relayDirectorUrl: 'https://relay.example.test'
    } as OrcaCloudAuthConfig,
    accessToken: 'access-token',
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.0.0',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attachTransport is the only member the broker calls, and nothing in this suite opens a mobile socket.
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    isCurrent: () => true,
    refreshAccessToken: async () => null,
    onStatus: vi.fn(),
    now: () => 0,
    random: () => 0.5,
    ...overrides
  }
}

const ACK: RelayHostHelloAckMessage = {
  type: 'host-hello-ack',
  v: 1,
  generation: 1,
  controlResumeSecret: 'R'.repeat(43),
  leaseExpiresAt: 1_000_000,
  activeConnIds: [],
  pendingConns: []
}

const ASSIGNMENT = {
  cellUrl: 'https://relay.example.test',
  assignmentEpoch: 1,
  leaseExpiresAt: 1_000_000
}

function drainActiveOrigin(): void {
  fakes.controls[0]!.options.onDrain({
    type: 'drain',
    graceMs: 5_000,
    recovery: 'resolve-director'
  })
}

/**
 * Every timer the pool and its broker can leave armed, each reached the way production reaches it.
 *
 * Why a table and not one case: teardown here is a hand-maintained list of verbs — `rotation.cancel()`,
 * `drainRetry.cancel()`, `retirement.clear()` — against three helper classes that each spell "disarm"
 * differently. `drainRetry.reset()` sat next to `rotation.cancel()` looking symmetric while only
 * zeroing a counter, and every behavioural test stayed green because the guard at fire time meant
 * nothing reopened. Counting timers is the only assertion that sees a leak with no behaviour.
 */
const ARMED_STATES: { name: string; arm: () => Promise<void> }[] = [
  {
    // Rotation is armed by openInitial itself, and the broker arms its lease refresh on connect.
    name: 'a live broker doing nothing else (control rotation + lease refresh)',
    arm: async () => {}
  },
  {
    name: 'a drain retry armed by a director refusal',
    arm: async () => {
      fakes.assign.mockRejectedValue(new Error('director_unavailable'))
      drainActiveOrigin()
      await vi.advanceTimersByTimeAsync(0)
    }
  },
  {
    name: 'an origin retirement grace armed by a rotation to a different cell',
    arm: async () => {
      // A different cellUrl skips the rebind arm and lands in activateTarget, which is what
      // schedules the grace. Something must still answer through the old origin or it retires now.
      fakes.pendingRequestCount = 1
      fakes.assign.mockResolvedValue({
        ...ASSIGNMENT,
        cellUrl: 'https://relay-2.example.test',
        assignmentEpoch: 2
      })
      drainActiveOrigin()
      await vi.advanceTimersByTimeAsync(0)
    }
  }
]

describe('RelayOriginPool teardown', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.controlConnect.mockReset()
    fakes.exchange.mockReset().mockResolvedValue({ relayToken: 'relay-jwt', expiresAt: 1_000_000 })
    fakes.assign.mockReset()
    fakes.pendingRequestCount = 0
  })

  it.each(ARMED_STATES)('leaves no timer armed after closeNow: $name', async ({ arm }) => {
    vi.useFakeTimers()
    try {
      fakes.controlConnect.mockResolvedValue(ACK)
      fakes.assign.mockResolvedValueOnce(ASSIGNMENT)

      const broker = await RelaySessionBroker.connect(brokerOptions())
      await arm()

      // The census must be able to find things: a case that armed nothing would assert 0 === 0 and
      // pass for the wrong reason, which is exactly how the drain-retry leak stayed invisible.
      expect(vi.getTimerCount(), 'nothing was armed, so this case guards nothing').toBeGreaterThan(
        0
      )

      broker.closeNow()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
