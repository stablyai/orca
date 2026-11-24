import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { BotShareDeviceStore } from './bot-share-device-store'
import { BOT_SHARE_DEVICES_FILENAME } from './mobile-pairing-files'

const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')

describe('the share device file', () => {
  it('writes back rows it could not read, so a save never revokes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-share-store-'))
    const path = join(dir, BOT_SHARE_DEVICES_FILENAME)
    // A newer build's row: unreadable here, but maybe a teammate's working device.
    const unknown = { deviceId: 'newer', botId: 'bot-1', kind: 'from-the-future' }
    writeFileSync(path, JSON.stringify({ v: 1, devices: [unknown] }))
    const store = new BotShareDeviceStore(dir, () => false)
    await store.add({
      botId: 'bot-1',
      accountId: 'acct-carol',
      name: 'Carol',
      scope: 'runtime',
      devicePublicKeyB64: key()
    })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      v: 1,
      devices: [expect.objectContaining({ accountId: 'acct-carol' }), unknown]
    })
    // Still unread after a restart, so its device is never told it was revoked.
    expect(new BotShareDeviceStore(dir, () => false).lookupDeviceKey('newer')).toEqual({
      kind: 'unavailable'
    })
  })
})
