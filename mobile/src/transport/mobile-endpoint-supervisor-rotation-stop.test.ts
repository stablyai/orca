import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  host,
  mockCredentialRotation
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor credential rotation after stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not persist relay routing from a rotation that finishes after stop', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    let finishCredentialWrite: (() => void) | undefined
    const credentialWritePending = new Promise<void>((resolve) => {
      finishCredentialWrite = resolve
    })
    const writeBundle = vi
      .fn<(value: MobileRelayCredentialBundle) => Promise<void>>()
      .mockResolvedValue()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(credentialWritePending)
    mockCredentialRotation(logical)
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        current: { ...bundle.current, expiresAt: Date.now() + 60_000 }
      })),
      writeBundle
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))
    supervisor.stop()
    finishCredentialWrite?.()
    await vi.advanceTimersByTimeAsync(0)

    // The rotated bundle itself stays durable; only the stale relay routing write is skipped.
    expect(writeBundle).toHaveBeenCalledTimes(2)
    expect(deps.saveRelayRouting).not.toHaveBeenCalled()
  })
})
