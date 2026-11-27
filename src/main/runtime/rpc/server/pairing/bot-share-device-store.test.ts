import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { BotShareDeviceStore } from './bot-share-device-store'
import { botSharePersonName } from '../../../../../shared/bots/bot-home-of'
import { withBotShareResolved, type BotShare } from '../../../../../shared/bots/bot-team-shares'
import { BOT_SHARE_DEVICES_FILENAME } from './mobile-pairing-files'

const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')

describe('the share device file', () => {
  it('writes back rows it could not read, so a save never revokes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-share-store-'))
    const path = join(dir, BOT_SHARE_DEVICES_FILENAME)
    // A newer build's row: unreadable here, but maybe a teammate's working device.
    const unknown = { deviceId: 'newer', botId: 'bot-1', kind: 'from-the-future' }
    writeFileSync(path, JSON.stringify({ v: 1, devices: [unknown] }))
    const store = new BotShareDeviceStore(
      dir,
      () => false,
      (grant) => grant.accountId
    )
    await store.add({
      botId: 'bot-1',
      accountId: 'acct-carol',
      scope: 'runtime',
      devicePublicKeyB64: key()
    })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      v: 1,
      devices: [expect.objectContaining({ accountId: 'acct-carol' }), unknown]
    })
    // Still unread after a restart, so its device is never told it was revoked.
    expect(
      new BotShareDeviceStore(
        dir,
        () => false,
        (grant) => grant.accountId
      ).lookupDeviceKey('newer')
    ).toEqual({
      kind: 'unavailable'
    })
  })

  it('writes each row with the teammate’s name for older builds, rewritten once a name arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-share-store-'))
    const path = join(dir, BOT_SHARE_DEVICES_FILENAME)
    let shares: readonly BotShare[] = [
      {
        kind: 'account',
        shareId: 's1',
        accountId: 'acct-pat',
        email: 'pat@example.com',
        addedAt: 1
      }
    ]
    const store = new BotShareDeviceStore(
      dir,
      () => true,
      (grant) => botSharePersonName({ shares: [...shares] }, grant.accountId)
    )
    await store.add({
      botId: 'bot-1',
      accountId: 'acct-pat',
      scope: 'runtime',
      devicePublicKeyB64: key()
    })
    // An older build requires a string name on every row.
    const written = () => JSON.parse(readFileSync(path, 'utf-8')).devices[0].name
    expect(written()).toBe('pat@example.com')
    shares =
      withBotShareResolved(shares, {
        shareId: 's1',
        email: 'pat@example.com',
        accountId: 'acct-pat',
        name: 'Pat Lee'
      }) ?? shares
    await store.syncLegacyNames()
    expect(written()).toBe('Pat Lee')
    // Read back, a row carries no name: nothing here can show a copy of it.
    expect(
      new BotShareDeviceStore(
        dir,
        () => true,
        () => ''
      ).list()[0]
    ).not.toHaveProperty('name')
  })
})
