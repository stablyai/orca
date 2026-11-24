// A teammate's computer asks the shared agent's host for its phone's key through the real dispatcher:
// the share allowlist admits it, the phone's key is a child of that computer's row, and Orca Cloud holds
// the phone's credential before the answer. A phone's own key can't ask, and ending it leaves the cloud.
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
import { BotShareProvisionedPhone } from '../../../../shared/bots/bot-share-phone'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const HASH = 'h'.repeat(43)

class PhoneShareServer extends OrcaRuntimeRpcServer {
  callAs(device: BotShareDevice, method: string, params: unknown): Promise<unknown> {
    return this.callAsBotShareDevice(device, method, params)
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
