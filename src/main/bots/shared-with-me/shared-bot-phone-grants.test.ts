// A phone's key to a shared agent is asked for over this computer's link, and ended on the host when
// the phone is unpaired here, retried until the host has taken it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../../../shared/remote-runtime/rpc/rpc-response-shape'
import { SharedBotHostStore, type SharedBotHostEntry } from './shared-bot-host-store'
import { SharedBotPhoneGrants } from './shared-bot-phone-grants'
import type { SharedBotLink } from './shared-bot-pairing'

const HOST_KEY = `${'A'.repeat(43)}=`
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const entry: SharedBotHostEntry = {
  shareId: 'share-1',
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
      inviteExpiresAt: 0
    },
    hostPublicKeyB64: HOST_KEY,
    deviceId: 'computer-1',
    botId: 'bot-1'
  },
  held: [],
  phones: []
}

function grants() {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-phones-'))
  dirs.push(dir)
  const store = new SharedBotHostStore(dir)
  store.put(entry)
  let link: SharedBotLink = 'live'
  let devices = 0
  const asked: [string, unknown][] = []
  const phones = new SharedBotPhoneGrants({
    store,
    listed: () => store.list(),
    reach: async () => link,
    request: async (_entry, method, params): Promise<RpcResponse> => {
      asked.push([method, params])
      return method === 'botShare.provisionPhone'
        ? {
            id: method,
            ok: true,
            result: { deviceId: `phone-key-${++devices}`, sealedOffer: 'sealed' }
          }
        : { id: method, ok: true, result: { revoked: true } }
    },
    origin: () => 'https://cloud.example'
  })
  return { store, phones, asked, setLink: (next: SharedBotLink) => (link = next) }
}

const ask = { shareId: 'share-1', devicePublicKey: 'k', sealKey: 's', credentialHash: 'h' }

describe('a phone’s key to a shared agent', () => {
  it('carries the pinned host key and where to hold messages', async () => {
    const { phones, asked, store } = grants()
    expect(await phones.provisionPhone('phone-a', ask)).toEqual({
      v: 1,
      shareId: 'share-1',
      botId: 'bot-1',
      botName: 'Ivy',
      ownerName: 'Jinwoo Hong',
      connectorOrigin: 'https://cloud.example',
      hostKey: HOST_KEY,
      sealedOffer: 'sealed'
    })
    await store.flushed()
    expect(asked).toEqual([
      ['botShare.provisionPhone', { devicePublicKey: 'k', sealKey: 's', credentialHash: 'h' }]
    ])
  })

  it('is refused while the host is away, and ends on the host once reached after an unpair', async () => {
    const { phones, store, asked, setLink } = grants()
    await phones.provisionPhone('phone-a', ask)
    // A new key from the same phone ends its earlier one there.
    await phones.provisionPhone('phone-a', ask)
    await vi.waitFor(() =>
      expect(store.get('share-1')?.phones).toEqual([
        { phoneDeviceId: 'phone-a', hostDeviceId: 'phone-key-2' }
      ])
    )
    expect(asked.at(-1)).toEqual(['botShare.revokePhone', { deviceId: 'phone-key-1' }])

    setLink('offline')
    await expect(phones.provisionPhone('phone-b', ask)).rejects.toThrow('shared_bot_host_offline')
    await phones.forgetPhone('phone-a')
    expect(store.get('share-1')?.phones).toEqual([
      { phoneDeviceId: 'phone-a', hostDeviceId: 'phone-key-2', removed: true }
    ])

    setLink('live')
    await phones.endRemoved('share-1')
    expect(asked.at(-1)).toEqual(['botShare.revokePhone', { deviceId: 'phone-key-2' }])
    expect(store.get('share-1')?.phones).toEqual([])
    await store.flushed()
  })
})
