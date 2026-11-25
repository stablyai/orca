// A share offered to this account waits for its Accept: nothing of it is kept or paired before, a
// Decline is kept for good, and a share accepted before Accept existed stays as it was.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from './shared-bot-hosts'
import { newSharedBotHostEntry, SharedBotHostStore } from './shared-bot-host-store'
import type { MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const offered: MineShare = {
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  botPurpose: 'Triages flaky tests and drafts the fix',
  hostOnline: true,
  state: 'needs-accept',
  held: []
}

/** The account's shared hosts in `dir`, over a cloud that lists `offered` and records each call. */
function hosts(dir = mkdtempSync(join(tmpdir(), 'shared-bot-accept-'))) {
  dirs.push(dir)
  const accepts: string[] = []
  const declines: string[] = []
  const cloud: SharedBotsCloud = {
    mine: async () => ({ ok: true, value: { v: 1, shares: [offered] } }),
    accept: async (shareId) => {
      accepts.push(shareId)
      return { ok: true, value: { status: 'queued' } }
    },
    decline: async (shareId) => {
      declines.push(shareId)
      return { ok: true, value: { status: 'declined' } }
    },
    hold: async () => ({ ok: true, value: { status: 'held' } })
  }
  const service = new SharedBotHosts({
    userDataPath: dir,
    account: () => 'ada',
    cloud: () => cloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: () => {},
    homes: memorySharedBotHomes(dir).homes,
    now: () => 1_000
  })
  return { service, accepts, declines, dir }
}

describe('a share offered to this account', () => {
  it('waits for Accept: no accept, no keys kept and not listed as an agent', async () => {
    const { service, accepts } = hosts()
    await service.refresh()
    service.stop()
    expect(accepts).toEqual([])
    expect(service.store.list()).toEqual([])
    expect(service.views()).toEqual([])
    expect(service.state().requests).toEqual([
      {
        shareId: 'share-1',
        botId: 'bot-1',
        botName: 'Ivy',
        ownerName: 'Jinwoo Hong',
        botPurpose: 'Triages flaky tests and drafts the fix'
      }
    ])
  })

  it('pairs on Accept: asks the host with a key it keeps, and lists the agent', async () => {
    const { service, accepts } = hosts()
    await service.refresh()
    expect(await service.accept('share-1')).toBe(true)
    service.stop()
    expect(accepts).toEqual(['share-1'])
    expect(service.store.get('share-1')?.acceptedAt).toBe(1_000)
    expect(service.views().map((view) => view.shareId)).toEqual(['share-1'])
    expect(service.state().requests).toEqual([])
  })

  it('never pairs once declined, tells the cloud, and is not offered again after a restart', async () => {
    const { service, accepts, declines, dir } = hosts()
    await service.refresh()
    expect(await service.decline('share-1')).toBe(true)
    await service.refresh()
    // Still listed (an older cloud never drops it): an Accept now, as from a phone that hasn't synced,
    // keeps and pairs nothing.
    expect(await service.accept('share-1')).toBe(false)
    service.stop()
    await service.flushed()
    expect(declines).toEqual(['share-1'])
    expect(service.state().requests).toEqual([])
    const again = hosts(dir)
    await again.service.refresh()
    expect(await again.service.accept('share-1')).toBe(false)
    again.service.stop()
    expect([...accepts, ...again.accepts]).toEqual([])
    expect(again.service.store.list()).toEqual([])
    expect(again.service.state().requests).toEqual([])
  })

  it('stays accepted when this computer accepted it before Accept existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-accept-'))
    const store = new SharedBotHostStore(dir)
    await store.load()
    store.put({ ...newSharedBotHostEntry(offered), acceptedAt: 500 })
    await store.flushed()
    const { service } = hosts(dir)
    await service.refresh()
    service.stop()
    expect(service.views().map((view) => view.shareId)).toEqual(['share-1'])
    expect(service.state().requests).toEqual([])
  })
})
