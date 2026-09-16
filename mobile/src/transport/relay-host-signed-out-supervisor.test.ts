import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import { RELAY_HOST_CLOSE_REASON } from '../../../src/shared/relay-host-close-reason'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// The reason travels from the cell's close frame to the screens. This covers
// the production wiring between them: the supervisor's own openRelay callback.
describe('a signed-out desktop reaches the phone verdict', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  function supervisorOver(closeReason: string | null) {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeRelaySession('disconnected')),
      openRelay: vi.fn((_relay, _credential, _confirmReqId, onHostCloseReason) => {
        if (closeReason) {
          onHostCloseReason?.(closeReason as never)
        }
        return new FakeRelaySession(
          'disconnected',
          new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE)
        )
      })
    })
    return { logical, supervisor: new MobileEndpointSupervisor(logical, host, deps) }
  }

  it('latches the sign-out the cell reported', async () => {
    const { logical, supervisor } = supervisorOver(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    await supervisor.start()
    await vi.waitFor(() => expect(logical.isHostSignedOut()).toBe(true))

    supervisor.stop()
  })

  it('stays quiet for an ordinary host-offline rejection', async () => {
    const { logical, supervisor } = supervisorOver(null)

    await supervisor.start()

    expect(logical.isHostSignedOut()).toBe(false)
    supervisor.stop()
  })
})
