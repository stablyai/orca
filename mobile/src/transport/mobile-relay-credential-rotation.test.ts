import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import {
  applyResumeConfirmation,
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import type { RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: 'host-1',
  deviceToken: 'device-token',
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 2,
    expiresAt: 50_000
  }
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function install(reqId: string) {
  return {
    v: 1 as const,
    reqId,
    authorizationMode: 'authenticated-direct' as const,
    currentVersion: 3,
    resumeExpiresAt: 100_000,
    graceExpiresAt: 70_000
  }
}

function fakeClient(responses: RpcResponse[]): RpcClient {
  return {
    sendRequest: vi.fn(async () => responses.shift()!),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
}

describe('mobile relay credential rotation', () => {
  it('persists pending material before install and promotes only committed status', async () => {
    const installed = install('rotate-CAgICAgICAgICAgICAgICA')
    const client = fakeClient([
      success({ v: 1, relay, installStatus: { v: 1, reqId: installed.reqId, state: 'not-found' } }),
      success(installed),
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: installed.reqId, state: 'committed', result: installed }
      })
    ])
    const writes: MobileRelayCredentialBundle[] = []

    const result = await rotateMobileRelayCredential({
      client,
      bundle,
      writeBundle: async (value) => {
        writes.push(value)
      },
      randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 7 : 8)
    })

    expect(writes).toHaveLength(2)
    expect(writes[0]!.pending).toMatchObject({ reqId: installed.reqId })
    expect(writes[0]!.pending!.hash).toBe('3Ev4DHdHPRMPoN6GukAY_pi7IUAF5qWJHRK6kURvnoE')
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'pairing.provisionRelay', {
      reqId: installed.reqId,
      newResumeTokenHash: writes[0]!.pending!.hash,
      expectedCurrentHash: bundle.current.hash
    })
    expect(result.bundle).toMatchObject({
      current: { version: 3, expiresAt: 100_000 },
      grace: { version: 2, expiresAt: 70_000 }
    })
    expect(result.bundle.pending).toBeUndefined()
  })

  it('repairs legacy decoded-byte hashes before the normal rotation window', () => {
    const now = 1_000
    const valid = {
      ...bundle,
      current: {
        ...bundle.current,
        hash: hashMobileRelayCredential(bundle.current.token),
        expiresAt: now + 30 * 24 * 60 * 60 * 1000
      }
    }

    expect(mobileRelayCredentialNeedsRotation(valid, now)).toBe(false)
    expect(mobileRelayCredentialNeedsRotation(bundle, now)).toBe(true)
    expect(
      mobileRelayCredentialNeedsRotation(
        { ...valid, pending: { token: 'C'.repeat(43), hash: 'D'.repeat(43), reqId: 'pending' } },
        now
      )
    ).toBe(true)
  })

  it('reconciles a committed lost response without issuing a second install', async () => {
    const pendingBundle: MobileRelayCredentialBundle = {
      ...bundle,
      pending: { token: 'C'.repeat(43), hash: 'D'.repeat(43), reqId: 'rotate-existing' }
    }
    const installed = install('rotate-existing')
    const client = fakeClient([
      success({
        v: 1,
        relay,
        installStatus: { v: 1, reqId: installed.reqId, state: 'committed', result: installed }
      })
    ])
    const writeBundle = vi.fn(async () => {})

    await rotateMobileRelayCredential({ client, bundle: pendingBundle, writeBundle })

    expect(client.sendRequest).toHaveBeenCalledOnce()
    expect(client.sendRequest).toHaveBeenCalledWith('pairing.getEndpoints', {
      installReqId: 'rotate-existing'
    })
    expect(writeBundle).toHaveBeenCalledOnce()
  })

  it('applies only authoritative current or grace confirmation expiries', () => {
    const withGrace: MobileRelayCredentialBundle = {
      ...bundle,
      grace: { token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1, expiresAt: 40_000 }
    }
    const renewed = applyResumeConfirmation(withGrace, 2, {
      v: 1,
      reqId: 'confirm-current',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: 120_000,
      graceExpiresAt: 40_000
    })
    const grace = applyResumeConfirmation(renewed, 1, {
      v: 1,
      reqId: 'confirm-grace',
      currentVersion: 2,
      acceptedAs: 'grace',
      renewed: false,
      resumeExpiresAt: 120_000,
      graceExpiresAt: 45_000
    })

    expect(renewed.current.expiresAt).toBe(120_000)
    expect(grace.grace?.expiresAt).toBe(45_000)
    expect(applyResumeConfirmation(grace, 99, { ...graceConfirmation(), reqId: 'other' })).toBe(
      grace
    )
  })
})

function graceConfirmation() {
  return {
    v: 1 as const,
    reqId: 'confirm',
    currentVersion: 2,
    acceptedAs: 'grace' as const,
    renewed: false,
    resumeExpiresAt: 120_000,
    graceExpiresAt: 45_000
  }
}
