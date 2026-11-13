// #34089: whether a paired server's host may be gone comes only from dials Orca already makes:
// its health probes and its control socket's reconnects.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'

const mocks = vi.hoisted(() => ({
  asleep: false,
  send: vi.fn()
}))

vi.mock('../../../runtime/construction/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({})
}))
vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: mocks.send
}))
vi.mock(
  '../../../../shared/remote-runtime/host-catalog/runtime-environments',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getPreferredPairedRuntimeConnection: () => ({ endpoint: 'ws://vm', credential: {} })
  })
)
vi.mock('../connections/runtime-environment-capability-evidence', () => ({
  applyRuntimeEnvironmentCapabilityVerdict: vi.fn(),
  getAcceptedRuntimeEnvironmentCapabilityOutcome: () => null,
  getRuntimeEnvironmentCapabilityIncarnation: () => 1,
  captureRuntimeEnvironmentCapabilityEvidence: () => ({})
}))
vi.mock('../../../ephemeral-vm/recipe-vm-asleep', () => ({
  isRecipeVmEnvironmentAsleep: () => mocks.asleep
}))

import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
import {
  clearRuntimeEnvironmentContactLoss,
  isRuntimeEnvironmentContactLost,
  noteRuntimeEnvironmentSharedControlContact,
  RUNTIME_CONTACT_LOST_AFTER_MS
} from './runtime-environment-contact-loss'

const ENV = 'env-vm'
const START = Date.parse('2026-11-08T12:00:00Z')

function owner() {
  const transport = { isReady: () => false, request: vi.fn(), establish: vi.fn(), pause: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the status owner reads.
  const environment = { id: ENV, pairingRevision: 1, createdAt: 0 } as KnownRuntimeEnvironment
  return createRuntimeEnvironmentStatusOwner('/data', environment, transport)
}

/** Three probes spread over `spanMs`, starting at START. */
async function probeOver(spanMs: number): Promise<void> {
  const status = owner()
  for (const at of [0, spanMs / 2, spanMs]) {
    vi.setSystemTime(START + at)
    await status.refresh({ timeoutMs: 1_000, observeOnly: true })
  }
}

const unreachable = (): never => {
  throw new RemoteRuntimeClientError('remote_runtime_unavailable', 'connect ECONNREFUSED')
}

describe('paired server contact loss', () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.asleep = false
    mocks.send.mockReset()
    clearRuntimeEnvironmentContactLoss(ENV)
  })

  it('is lost only after minutes of failed health probes, and found again by an answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mocks.send.mockImplementation(unreachable)
    await probeOver(RUNTIME_CONTACT_LOST_AFTER_MS / 2)
    expect(isRuntimeEnvironmentContactLost(ENV)).toBe(false)

    await probeOver(RUNTIME_CONTACT_LOST_AFTER_MS)
    expect(isRuntimeEnvironmentContactLost(ENV)).toBe(true)

    mocks.send.mockResolvedValue({ id: 'status.get', ok: true, result: {}, _meta: {} })
    await owner().refresh({ timeoutMs: 1_000, observeOnly: true })
    expect(isRuntimeEnvironmentContactLost(ENV)).toBe(false)
  })

  it('counts nothing for a VM the user put to sleep, which is never dialed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mocks.asleep = true
    await probeOver(RUNTIME_CONTACT_LOST_AFTER_MS * 2)
    expect(isRuntimeEnvironmentContactLost(ENV)).toBe(false)
  })

  it('counts each control-socket reconnect once, but not a socket the user closed', () => {
    const spread = [0, RUNTIME_CONTACT_LOST_AFTER_MS / 2, RUNTIME_CONTACT_LOST_AFTER_MS]
    for (const at of spread) {
      noteRuntimeEnvironmentSharedControlContact(
        ENV,
        { state: 'closed', reconnectAttempt: 0 },
        START + at
      )
    }
    expect(isRuntimeEnvironmentContactLost(ENV, START + RUNTIME_CONTACT_LOST_AFTER_MS)).toBe(false)

    // One reconnect attempt republished as its pending requests change is still one failure.
    for (const at of spread) {
      noteRuntimeEnvironmentSharedControlContact(
        ENV,
        { state: 'reconnecting', reconnectAttempt: 1 },
        START + at
      )
    }
    expect(isRuntimeEnvironmentContactLost(ENV, START + RUNTIME_CONTACT_LOST_AFTER_MS)).toBe(false)

    spread.forEach((at, index) =>
      noteRuntimeEnvironmentSharedControlContact(
        ENV,
        { state: 'reconnecting', reconnectAttempt: index + 2 },
        START + at
      )
    )
    expect(isRuntimeEnvironmentContactLost(ENV, START + RUNTIME_CONTACT_LOST_AFTER_MS)).toBe(true)

    noteRuntimeEnvironmentSharedControlContact(ENV, { state: 'ready', reconnectAttempt: 0 })
    expect(isRuntimeEnvironmentContactLost(ENV, START + RUNTIME_CONTACT_LOST_AFTER_MS)).toBe(false)
  })

  it('starts over after a quiet spell longer than any retry, such as the computer sleeping', () => {
    // A drop as the computer went to sleep, then quick failures while its network comes back.
    noteRuntimeEnvironmentSharedControlContact(
      ENV,
      { state: 'reconnecting', reconnectAttempt: 1 },
      START
    )
    const woke = START + 8 * 60 * 60_000
    for (const [index, at] of [0, 2_000, 4_000].entries()) {
      noteRuntimeEnvironmentSharedControlContact(
        ENV,
        { state: 'reconnecting', reconnectAttempt: index + 2 },
        woke + at
      )
    }
    expect(isRuntimeEnvironmentContactLost(ENV, woke + 5_000)).toBe(false)
  })
})
