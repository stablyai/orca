// The fixtures the phone's shared-agent tests share: the teammate's computer answering as the
// agent's host would, and Orca Cloud's share endpoints. Tests mock AsyncStorage and the keychain.
import nacl from 'tweetnacl'
import { vi } from 'vitest'
import { SharedBotsPhoneProvisionParams } from '../../../../src/shared/bots/bot-share-phone'
import { sealBotTeamShareOffer } from '../../../../src/shared/bots/bot-team-share-seal'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'

export const HOST = nacl.box.keyPair()
export const HOST_KEY = PRIMITIVES.encodeBase64(HOST.publicKey)
export const CHAT = '00000000-0000-4000-8000-000000000001'
export const share = {
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  environmentId: 'env-1'
}
export const SHARED = { envelope: { executionHost: 'runtime:env-1' } }

/** The teammate's computer as the phone's paired host: its shares, a key per ask, and the page calls
 *  it should not get. */
export function computer() {
  const asks: SharedBotsPhoneProvisionParams[] = []
  const desktopCalls: string[] = []
  const sendRequest = async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'sharedBots.phone.list') {
      return { id: method, ok: true, result: { shares: [share] } }
    }
    if (method !== 'sharedBots.phone.provision') {
      desktopCalls.push(method)
      return { id: method, ok: true, result: {} }
    }
    const ask = SharedBotsPhoneProvisionParams.parse(params)
    asks.push(ask)
    const offer = {
      v: 1 as const,
      relay: {
        v: 1 as const,
        directorUrl: 'https://director.example',
        cellUrl: 'https://cell.example',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'i'.repeat(43),
        e2eeFraming: 2 as const,
        // Lapsed: the phone never dials it here, so the host is away for this test.
        inviteExpiresAt: 10
      },
      hostPublicKeyB64: HOST_KEY,
      deviceId: 'phone-key-1',
      botId: 'bot-1'
    }
    const result = {
      v: 1,
      ...share,
      connectorOrigin: 'https://cloud.example',
      hostKey: HOST_KEY,
      sealedOffer: sealBotTeamShareOffer(PRIMITIVES, { sealKey: ask.sealKey, offer })
    }
    return { id: method, ok: true, result }
  }
  return { asks, desktopCalls, client: { sendRequest } }
}

export type CloudCall = { url: string; method: string; authorization: string; body: unknown }

/** Orca Cloud's share endpoints; the first `failedReads` reads of held states fail. */
export function cloud(failedReads = 0) {
  const calls: CloudCall[] = []
  let states: { clientMessageId: string; state: string }[] = []
  let reads = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
      body
    })
    if (init.method === 'POST') {
      return Response.json({ status: 'held' })
    }
    return ++reads <= failedReads
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ v: 1, held: states })
  })
  return { calls, setStates: (next: typeof states) => (states = next) }
}
