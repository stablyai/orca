import { describe, expect, it, vi } from 'vitest'
import { hashRelayCredential } from '../../../../src/shared/remote-runtime/relay/relay-credential-hash'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../../host-credentials/pairing-keychain', () => ({}))

import { rotateMobileRelayCredential } from './mobile-relay-credential-rotation'

const CURRENT = 'c'.repeat(43)
const RELAY = {
  v: 1,
  directorUrl: 'https://director.example',
  cellUrl: 'https://cell.example',
  assignmentEpoch: 1,
  relayHostId: 'relay-host-0001x',
  e2eeFraming: 2
}

function hostWithInstall(alreadyCommitted: boolean) {
  const calls: { method: string; params: unknown }[] = []
  let installed: Record<string, unknown> | null = null
  const sendRequest = vi.fn(
    async (method: string, params: { reqId?: string; installReqId?: string } = {}) => {
      calls.push({ method, params })
      const { reqId, installReqId } = params
      if (method === 'pairing.provisionRelay') {
        installed = {
          v: 1,
          reqId,
          authorizationMode: 'authenticated-direct',
          currentVersion: 6,
          resumeExpiresAt: 2_000,
          graceExpiresAt: 1_500
        }
        return { id: 'p', ok: true as const, result: installed }
      }
      installed ??= alreadyCommitted
        ? {
            v: 1,
            reqId: installReqId,
            authorizationMode: 'authenticated-direct',
            currentVersion: 6,
            resumeExpiresAt: 2_000
          }
        : null
      const installStatus = installed
        ? { v: 1, reqId: installReqId, state: 'committed', result: installed }
        : { v: 1, reqId: installReqId, state: 'not-found' }
      return { id: 'e', ok: true as const, result: { v: 1, relay: RELAY, installStatus } }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rotation only calls sendRequest.
  return { calls, client: { sendRequest } as unknown as RpcClient }
}

const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: 'host-1',
  deviceToken: 'token',
  current: { token: CURRENT, hash: hashRelayCredential(CURRENT), version: 5, expiresAt: 1_000 }
}

describe('rotateMobileRelayCredential', () => {
  it('installs against the current hash and promotes the pending credential only once committed', async () => {
    const { calls, client } = hostWithInstall(false)
    const written: MobileRelayCredentialBundle[] = []
    const result = await rotateMobileRelayCredential({
      client,
      bundle,
      writeBundle: async (next) => void written.push(next)
    })
    const pending = written[0].pending!
    expect(calls.map((call) => call.method)).toEqual([
      'pairing.getEndpoints',
      'pairing.provisionRelay',
      'pairing.getEndpoints'
    ])
    expect(calls[1].params).toEqual({
      reqId: pending.reqId,
      newResumeTokenHash: pending.hash,
      expectedCurrentHash: bundle.current.hash
    })
    expect(result.bundle.current).toEqual({
      ...pending,
      reqId: undefined,
      version: 6,
      expiresAt: 2_000
    })
    expect(result.bundle.grace).toEqual({ ...bundle.current, expiresAt: 1_500 })
    expect(result.bundle.pending).toBeUndefined()
  })

  it('promotes a pending credential the host already committed without provisioning again', async () => {
    const { calls, client } = hostWithInstall(true)
    const pending = {
      token: 'p'.repeat(43),
      hash: hashRelayCredential('p'.repeat(43)),
      reqId: 'r1'
    }
    const result = await rotateMobileRelayCredential({
      client,
      bundle: { ...bundle, pending },
      writeBundle: async () => {}
    })
    expect(calls.map((call) => call.method)).toEqual(['pairing.getEndpoints'])
    expect(result.bundle.current).toMatchObject({ token: pending.token, version: 6 })
  })
})
