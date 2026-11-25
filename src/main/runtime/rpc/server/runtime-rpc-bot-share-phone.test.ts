// A teammate's computer asks the shared agent's host for its phone's key through the real dispatcher:
// the share allowlist admits it, the phone's key is a child of that computer's row, and Orca Cloud holds
// the phone's credential before the answer. A phone's own key can't ask, and ending it leaves the cloud.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { openBotTeamShareOffer } from '../../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { ConnectorCloud } from '../../../connector-cloud/connector-cloud'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { BotShareDevice } from './pairing/bot-share-device-store'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  BotShareProvisionedPhone,
  SharedBotPhoneGrant
} from '../../../../shared/bots/bot-share-phone'
import { SharedBotHostStore } from '../../../bots/shared-with-me/shared-bot-host-store'
import { SharedBotPhoneGrants } from '../../../bots/shared-with-me/shared-bot-phone-grants'
import { routeSharedHostsThrough } from '../../../ipc/runtime-environments/requests/runtime-environment-shared-hosts'
import { BotSharePhoneCredentialOutbox } from '../../../bots/team-share/bot-share-phone-credentials'
import * as secureWrite from '../../../../shared/secure-storage/secure-file-async-write'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const HASH = 'h'.repeat(43)

class PhoneShareServer extends OrcaRuntimeRpcServer {
  callAs(device: BotShareDevice, method: string, params: unknown): Promise<unknown> {
    return this.callAsBotShareDevice(device, method, params)
  }

  /** A call from a phone paired to this computer, directly or through another computer. */
  callAsPhone(deviceId: string, delegated: boolean, method: string, params: unknown) {
    return this.dispatcher.dispatch(
      { id: randomUUID(), authToken: '', method, params },
      {
        pairedDeviceId: deviceId,
        clientId: deviceId,
        clientKind: 'mobile',
        callerScope: { kind: 'mobile', delegated }
      }
    )
  }
}

let userDataPath: string
let server: PhoneShareServer
let cloudCalls: { path: string; body: unknown; method?: string }[]
let cloudAnswers: boolean
let bot: Pick<Bot, 'id' | 'shares'>
// Invites minted at a fixed time, an hour past which nothing in a test reads them.
const INVITE_EXPIRES_AT = 4_000_000_000_000

async function fakeCloudCall(
  path: string,
  body: unknown,
  _schema: unknown,
  options?: { method?: string }
) {
  cloudCalls.push({ path, body, method: options?.method })
  return cloudAnswers
    ? { ok: true, value: undefined }
    : { ok: false, status: 503, error: null, retryAfterMs: null }
}

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-share-phone-'))
  const runtime = new OrcaRuntimeService()
  bot = {
    id: 'bot-1',
    shares: [
      {
        kind: 'account',
        shareId: 'share-alice',
        accountId: 'acct-alice',
        name: 'Alice',
        email: 'alice@example.com',
        addedAt: 1
      }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share checks read only a bot's id and shares.
  vi.spyOn(runtime.bots, 'list').mockImplementation(() => [bot] as unknown as Bot[])
  cloudCalls = []
  cloudAnswers = true
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the credential calls use only call.
  vi.spyOn(runtime, 'getConnectorCloud').mockReturnValue({
    call: fakeCloudCall
  } as unknown as ConnectorCloud)
  server = new PhoneShareServer({ runtime, userDataPath, enableWebSocket: true, wsPort: 0 })
  await server.start()
  let invites = 0
  server.setMobileRelayPairingProvider({
    createPairingRelay: async (relayDeviceId) => {
      invites += 1
      return {
        relay: {
          v: 1,
          directorUrl: 'https://director.example',
          cellUrl: 'https://cell.example',
          assignmentEpoch: 1,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: `invite-${invites}`.padEnd(43, 'x'),
          inviteExpiresAt: INVITE_EXPIRES_AT,
          e2eeFraming: 2
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'owner',
          inviteExpiresAt: INVITE_EXPIRES_AT
        }
      }
    },
    onDeviceRevokeQueued: () => {},
    getEndpoints: async () => {
      throw new Error('unused')
    },
    provisionRelay: async () => {
      throw new Error('unused')
    }
  })
})

afterEach(async () => {
  await server.stop()
  rmSync(userDataPath, { recursive: true, force: true })
})

async function teammateComputer(): Promise<BotShareDevice> {
  return await server.getBotShareDevices()!.add({
    botId: 'bot-1',
    accountId: 'acct-alice',
    name: 'Alice',
    scope: 'runtime',
    devicePublicKeyB64: b64(nacl.sign.keyPair().publicKey)
  })
}

async function provision(device: BotShareDevice, params: unknown) {
  return BotShareProvisionedPhone.parse(
    await server.callAs(device, 'botShare.provisionPhone', params)
  )
}

function phoneAsk() {
  const device = nacl.sign.keyPair()
  const seal = nacl.box.keyPair()
  return {
    seal,
    params: {
      devicePublicKey: b64(device.publicKey),
      sealKey: b64(seal.publicKey),
      credentialHash: HASH
    }
  }
}

describe('a teammate’s phone key', () => {
  it('is a child of the asking computer, its credential installed before the answer', async () => {
    const computer = await teammateComputer()
    const { seal, params } = phoneAsk()

    const answer = await provision(computer, params)

    const phone = server.getBotShareDevices()!.get(answer.deviceId)
    expect(phone).toMatchObject({
      botId: 'bot-1',
      accountId: 'acct-alice',
      scope: 'mobile',
      parentDeviceId: computer.deviceId,
      shareId: 'share-alice',
      devicePublicKeyB64: params.devicePublicKey
    })
    expect(cloudCalls).toEqual([
      {
        path: `/v1/connector/bots/bot-1/shares/share-alice/devices/${answer.deviceId}`,
        body: { v: 1, credentialHash: HASH },
        method: 'PUT'
      }
    ])
    const offer = openBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
      sealSecretKey: seal.secretKey,
      sealed: answer.sealedOffer,
      expect: { botId: 'bot-1' }
    })
    expect(offer?.deviceId).toBe(answer.deviceId)
    expect(offer?.hostPublicKeyB64).toBe(server.getE2EEPublicKey())
    // The same phone asking again keeps its one row.
    const again = await provision(computer, params)
    expect(again.deviceId).toBe(answer.deviceId)
  })

  it('is refused to a phone’s own key, and leaves no row when Orca Cloud took no credential', async () => {
    const computer = await teammateComputer()
    const first = await provision(computer, phoneAsk().params)
    const phone = server.getBotShareDevices()!.get(first.deviceId)!
    await expect(
      server.callAs(phone, 'botShare.provisionPhone', phoneAsk().params)
    ).rejects.toThrow()

    cloudAnswers = false
    await expect(
      server.callAs(computer, 'botShare.provisionPhone', phoneAsk().params)
    ).rejects.toThrow()
    expect(
      server
        .getBotShareDevices()!
        .list()
        .map((row) => row.deviceId)
    ).toEqual([computer.deviceId, phone.deviceId])
  })

  it('ends only that computer’s phone, and removes its credential from Orca Cloud', async () => {
    const computer = await teammateComputer()
    const other = await teammateComputer()
    const { deviceId } = await provision(computer, phoneAsk().params)

    expect(await server.callAs(other, 'botShare.revokePhone', { deviceId })).toEqual({
      revoked: false
    })
    expect(server.getBotShareDevices()!.get(deviceId)).not.toBeNull()

    cloudCalls = []
    expect(await server.callAs(computer, 'botShare.revokePhone', { deviceId })).toEqual({
      revoked: true
    })
    expect(server.getBotShareDevices()!.get(deviceId)).toBeNull()
    await vi.waitFor(() =>
      expect(cloudCalls).toContainEqual({
        path: `/v1/connector/bots/bot-1/shares/share-alice/devices/${deviceId}`,
        body: undefined,
        method: 'DELETE'
      })
    )
  })
})

describe('a phone the share is gone for', () => {
  it('is refused at sign-in along with its computer, by the same share check', async () => {
    const computer = await teammateComputer()
    const { deviceId } = await provision(computer, phoneAsk().params)
    const devices = server.getBotShareDevices()!
    expect(devices.lookupDeviceKey(deviceId).kind).toBe('found')
    bot = { ...bot, shares: [] }
    expect(devices.lookupDeviceKey(deviceId).kind).toBe('refused')
    expect(devices.lookupDeviceKey(computer.deviceId).kind).toBe('refused')
  })
})

describe('a phone asking its own computer for a key', () => {
  afterEach(() => routeSharedHostsThrough(null))

  it('gets a grant through the computer’s link to the host, and a delegated phone gets nothing', async () => {
    const computer = await teammateComputer()
    const store = new SharedBotHostStore(userDataPath)
    store.put({
      shareId: 'share-alice',
      environmentId: 'env-1',
      botId: 'bot-1',
      botName: 'Ivy',
      ownerName: 'Jinwoo Hong',
      deviceKey: { publicKeyB64: 'd', secretKeyB64: 'd' },
      sealKey: { publicKeyB64: 's', secretKeyB64: 's' },
      offer: {
        v: 1,
        relay: {
          v: 1,
          directorUrl: 'https://director.example',
          cellUrl: 'https://cell.example',
          assignmentEpoch: 1,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'i'.repeat(43),
          e2eeFraming: 2,
          inviteExpiresAt: INVITE_EXPIRES_AT
        },
        hostPublicKeyB64: server.getE2EEPublicKey()!,
        deviceId: computer.deviceId,
        botId: 'bot-1'
      },
      held: [],
      phones: []
    })
    // The computer's link to the agent's host is this same host, called as the computer's share device.
    const phones = new SharedBotPhoneGrants({
      store,
      listed: () => store.list(),
      reach: async () => 'live',
      request: async (_entry, method, params) => ({
        id: method,
        ok: true,
        result: await server.callAs(computer, method, params)
      }),
      origin: () => 'https://cloud.example'
    })
    routeSharedHostsThrough({
      hosts: {
        ready: async () => {},
        settled: async () => {},
        reaches: () => false,
        views: () => [],
        store,
        call: async () => {
          throw new Error('unused')
        },
        subscribe: async () => {
          throw new Error('unused')
        },
        phones
      },
      methods: { allows: () => false, streams: () => false }
    })
    const { seal, params } = phoneAsk()

    const answer = await server.callAsPhone('phone-a', false, 'sharedBots.phone.provision', {
      ...params,
      shareId: 'share-alice'
    })
    const grant = SharedBotPhoneGrant.parse(answer.ok ? answer.result : null)
    expect(grant.hostKey).toBe(server.getE2EEPublicKey())
    const offer = openBotTeamShareOffer(NODE_PAIRED_E2EE_PRIMITIVES, {
      sealSecretKey: seal.secretKey,
      sealed: grant.sealedOffer,
      expect: { botId: 'bot-1' }
    })
    expect(server.getBotShareDevices()!.get(offer!.deviceId)?.parentDeviceId).toBe(
      computer.deviceId
    )

    const delegated = await server.callAsPhone('phone-b', true, 'sharedBots.phone.list', null)
    expect(delegated.ok).toBe(false)
    await store.flushed()
  })
})

describe('the phone credential outbox', () => {
  it('keeps a removal Orca Cloud refused, and one whose write failed, until a later drain takes it', async () => {
    let answers = false
    const deletes: string[] = []
    const cloud = {
      call: async (path: string) => {
        deletes.push(path)
        return answers
          ? { ok: true as const, value: undefined }
          : { ok: false as const, status: 503, error: null, retryAfterMs: null }
      }
    }
    const outbox = new BotSharePhoneCredentialOutbox(userDataPath, () => cloud)
    const phoneA = { botId: 'bot-1', shareId: 'share-alice', deviceId: 'phone-a' }
    const phoneB = { ...phoneA, deviceId: 'phone-b' }
    await outbox.remove(phoneA)
    await outbox.drain()
    expect(outbox.pending()).toEqual([phoneA])

    // A write that fails leaves the outbox as the disk has it; the retry writes it.
    const write = vi
      .spyOn(secureWrite, 'writeSecureFileAsync')
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(outbox.remove(phoneB)).rejects.toThrow('disk full')
    expect(outbox.pending()).toEqual([phoneA])
    write.mockRestore()
    await outbox.remove(phoneB)
    outbox.stop()

    // Read back after a restart, and drained once Orca Cloud takes them.
    const restarted = new BotSharePhoneCredentialOutbox(userDataPath, () => cloud)
    answers = true
    await restarted.drain()
    restarted.stop()
    expect(restarted.pending()).toEqual([])
    expect(deletes.slice(-2)).toEqual([
      '/v1/connector/bots/bot-1/shares/share-alice/devices/phone-a',
      '/v1/connector/bots/bot-1/shares/share-alice/devices/phone-b'
    ])
  })
})
