import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { rotateMobileRelayCredential } from '../relay/mobile-relay-credential-rotation'
import { RelayDirectorHttpError } from '../relay/mobile-relay-resume-director'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import {
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  bundle,
  dependencies,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('../../host-credentials/pairing-keychain', () => ({
  deletePairingKeychainItem: vi.fn(),
  readPairingKeychainItem: vi.fn(),
  writePairingKeychainItem: vi.fn()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

describe('Relay credential recovery', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    {
      description: 'retries after a bare close',
      rejectedByRelayHello: false,
      expectedDials: 2,
      expected: 'connected'
    },
    {
      description: 'waits after an explicit refusal',
      rejectedByRelayHello: true,
      expectedDials: 1,
      expected: 'disconnected'
    }
  ])('$description', async ({ rejectedByRelayHello, expectedDials, expected }) => {
    vi.useFakeTimers()
    const logical = new FakeLogicalClient('disconnected', 'relay')
    const openRelay = vi
      .fn(() => new FakeRelaySession('connected'))
      .mockReturnValueOnce(
        new FakeRelaySession('disconnected', new RelayOuterError(4401, rejectedByRelayHello))
      )
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openRelay, directUnavailable: true })
    )

    try {
      await supervisor.start()
      // Covers the first transport backoff ceiling but stays under the credential-gate reprobe.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(openRelay).toHaveBeenCalledTimes(expectedDials)
      expect(logical.getState()).toBe(expected)
    } finally {
      supervisor.stop()
    }
  })

  // The cell refuses the old token at hello, or the old cell is gone and the director refuses it.
  it.each(['relay-hello', 'director'] as const)(
    'adopts a committed rotation whose reply was lost on the next Relay dial (%s refusal)',
    async (refusedBy) => {
      let stored: MobileRelayCredentialBundle = bundle
      const writeBundle = vi.fn(async (next: MobileRelayCredentialBundle) => {
        stored = next
      })
      const randomBytes = (length: number) => new Uint8Array(length).fill(1)
      // The desktop commits the install, then the direct socket drops before the reply arrives.
      const direct = new FakeSession('connected')
      direct.sendRequest.mockImplementation(async (method) => {
        if (method === 'pairing.provisionRelay') {
          throw new Error('socket closed')
        }
        return {
          id: 'rpc-1',
          ok: true,
          result: { v: 1, relay, installStatus: { v: 1, reqId: 'r', state: 'not-found' } },
          _meta: { runtimeId: 'runtime-1' }
        }
      })
      await expect(
        rotateMobileRelayCredential({ client: direct, bundle, writeBundle, randomBytes })
      ).rejects.toThrow('socket closed')
      const pending = stored.pending
      expect(pending).toBeDefined()

      // Past the 24h grace the relay accepts only the committed install.
      const openRelay = vi.fn((_relay: unknown, credential: { token: string; version: number }) => {
        if (credential.token !== pending?.token) {
          return new FakeRelaySession(
            'disconnected',
            refusedBy === 'director' ? new RelayOuterError(4409) : new RelayOuterError(4401, true)
          )
        }
        const accepted = new FakeRelaySession('connected')
        accepted.getResumeConfirmation = () => ({
          v: 1,
          reqId: 'confirm-1',
          currentVersion: 3,
          acceptedAs: 'current',
          renewed: true,
          resumeExpiresAt: 2_000_000_000_000
        })
        return accepted
      })
      const logical = new FakeLogicalClient('disconnected', 'relay')
      const supervisor = new MobileEndpointSupervisor(
        logical,
        host.id,
        relay,
        dependencies({
          openRelay,
          readBundle: vi.fn(async () => stored),
          resolveRelay: vi.fn(async () => {
            throw new RelayDirectorHttpError(401, null)
          }),
          writeBundle,
          directUnavailable: true
        })
      )
      try {
        await supervisor.start()
        expect(logical.getState()).toBe('connected')
        expect(openRelay).toHaveBeenLastCalledWith(
          relay,
          {
            token: pending?.token,
            hash: pending?.hash,
            version: 3,
            expiresAt: Number.MAX_SAFE_INTEGER
          },
          expect.any(String),
          expect.any(Function)
        )
        expect(stored.pending).toBeUndefined()
        expect(stored.current).toEqual({
          token: pending?.token,
          hash: pending?.hash,
          version: 3,
          expiresAt: 2_000_000_000_000
        })
      } finally {
        supervisor.stop()
      }
    }
  )

  // The old cell knows neither token, and the director refuses the old one: only pending's own lookup finds the host.
  it('recovers a lost rotation on a later attempt after the host moved cells', async () => {
    let stored: MobileRelayCredentialBundle = bundle
    const writeBundle = vi.fn(async (next: MobileRelayCredentialBundle) => {
      stored = next
    })
    const direct = new FakeSession('connected')
    direct.sendRequest.mockImplementation(async (method) => {
      if (method === 'pairing.provisionRelay') {
        throw new Error('socket closed')
      }
      return {
        id: 'rpc-1',
        ok: true,
        result: { v: 1, relay, installStatus: { v: 1, reqId: 'r', state: 'not-found' } },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    await expect(
      rotateMobileRelayCredential({
        client: direct,
        bundle,
        writeBundle,
        randomBytes: (length) => new Uint8Array(length).fill(1)
      })
    ).rejects.toThrow('socket closed')
    const pending = stored.pending
    expect(pending).toBeDefined()

    vi.useFakeTimers()
    const moved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
    const openRelay = vi.fn((cell: typeof relay, credential: { token: string }) => {
      if (cell.cellUrl !== moved.cellUrl || credential.token !== pending?.token) {
        return new FakeRelaySession('disconnected', new RelayOuterError(4409))
      }
      const accepted = new FakeRelaySession('connected')
      accepted.getResumeConfirmation = () => ({
        v: 1,
        reqId: 'confirm-1',
        currentVersion: 3,
        acceptedAs: 'current',
        renewed: true,
        resumeExpiresAt: 2_000_000_000_000
      })
      return accepted
    })
    const resolveRelay = vi.fn(async ({ resumeToken }: { resumeToken: string }) => {
      if (resumeToken !== pending?.token) {
        throw new RelayDirectorHttpError(401, null)
      }
      return moved
    })
    const logical = new FakeLogicalClient('disconnected', 'relay')
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({
        openRelay,
        readBundle: vi.fn(async () => stored),
        resolveRelay,
        writeBundle,
        directUnavailable: true
      })
    )
    try {
      await supervisor.start()
      expect(logical.getState()).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logical.getState()).toBe('connected')
      expect(resolveRelay).toHaveBeenLastCalledWith(
        expect.objectContaining({ resumeToken: pending?.token })
      )
      expect(stored.pending).toBeUndefined()
      expect(stored.current.version).toBe(3)
    } finally {
      supervisor.stop()
    }
  })

  // A refused pending may still commit, so it stays dialable, but only on the slow credential reprobe.
  it('backs a refused pending off to the slow credential reprobe', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const refused: MobileRelayCredentialBundle = {
      ...bundle,
      current: { ...bundle.current, expiresAt: start + 3_600_000 },
      pending: { token: 'C'.repeat(43), hash: 'D'.repeat(43), reqId: 'rotate-lost' }
    }
    const openRelay = vi.fn(
      (_cell: unknown, _credential: { token: string }) =>
        new FakeRelaySession('disconnected', new RelayOuterError(4401, true))
    )
    const pendingDials = () =>
      openRelay.mock.calls.filter(([, credential]) => credential.token === refused.pending?.token)
        .length
    const logical = new FakeLogicalClient('disconnected', 'relay')
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({
        openRelay,
        readBundle: vi.fn(async () => refused),
        directUnavailable: true
      })
    )
    try {
      await supervisor.start()
      expect(pendingDials()).toBe(1)
      // Transport backoff would redial within 30 s; the credential reprobe waits at least 45 s.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(pendingDials()).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(pendingDials()).toBe(2)
    } finally {
      supervisor.stop()
    }
  })

  // A gated pending reprobe whose director lookup is paced must not ask the director again before Retry-After.
  it('honors a director Retry-After on a gated pending reprobe', async () => {
    vi.useFakeTimers()
    const refused: MobileRelayCredentialBundle = {
      ...bundle,
      pending: { token: 'C'.repeat(43), hash: 'D'.repeat(43), reqId: 'rotate-lost' }
    }
    // The first attempt is refused at relay-hello; later pending dials land on a cell that sends them to the director.
    const openRelay = vi
      .fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401, true)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401, true)))
    const resolveRelay = vi.fn(async () => {
      throw new RelayDirectorHttpError(503, 120_000)
    })
    const supervisor = new MobileEndpointSupervisor(
      new FakeLogicalClient('disconnected', 'relay'),
      host.id,
      relay,
      dependencies({
        openRelay,
        resolveRelay,
        readBundle: vi.fn(async () => refused),
        directUnavailable: true
      })
    )
    try {
      await supervisor.start()
      // Step to the first gated reprobe (45-75 s), which gets the 503.
      for (let second = 0; second < 80 && resolveRelay.mock.calls.length === 0; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(resolveRelay).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(118_000)
      expect(resolveRelay).toHaveBeenCalledTimes(1)
    } finally {
      supervisor.stop()
    }
  })
})
