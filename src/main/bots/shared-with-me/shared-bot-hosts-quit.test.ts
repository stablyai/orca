// The agents kept here outlive a quit: a stop drops every read, one already out included, and a
// "signed out" answer clears them only when no account is signed in, never because the connector is
// fenced for quitting or the cloud is unreachable.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from './shared-bot-hosts'
import {
  newSharedBotHostEntry,
  SHARED_BOT_HOSTS_FILENAME,
  SharedBotHostStore
} from './shared-bot-host-store'
import type { MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const accepted: MineShare = {
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  hostOnline: false,
  state: 'ready',
  held: []
}

type MineAnswer = Awaited<ReturnType<SharedBotsCloud['mine']>>
const SIGNED_OUT: MineAnswer = { ok: false, status: 401, error: 'signed_out', retryAfterMs: null }

/** A computer that accepted `accepted` before, over a cloud whose list read answers `mine`. */
async function kept(mine: () => Promise<MineAnswer>, account: () => string | null = () => 'ada') {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-quit-'))
  dirs.push(dir)
  const store = new SharedBotHostStore(dir)
  await store.load()
  store.put({ ...newSharedBotHostEntry(accepted), acceptedAt: 500 })
  await store.flushed()
  // What a relaunch pairs as: the share, its environment id and this device's keys.
  const file = () => {
    const saved: { shares: { shareId: string; environmentId: string; deviceKey: unknown }[] } =
      JSON.parse(readFileSync(join(dir, SHARED_BOT_HOSTS_FILENAME), 'utf8'))
    return saved.shares.map(({ shareId, environmentId, deviceKey }) => ({
      shareId,
      environmentId,
      deviceKey
    }))
  }
  const before = file()
  const cloud: SharedBotsCloud = {
    mine,
    accept: async () => ({ ok: true, value: { status: 'queued' } }),
    decline: async () => ({ ok: true, value: { status: 'declined' } }),
    hold: async () => ({ ok: true, value: { status: 'held' } })
  }
  const service = new SharedBotHosts({
    userDataPath: dir,
    account,
    cloud: () => cloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: () => {},
    homes: memorySharedBotHomes(dir).homes,
    now: () => 1_000
  })
  return { service, file, before }
}

describe('the agents kept on this computer', () => {
  it('stay as they are when Orca quits with a read still out', async () => {
    let answer: (value: MineAnswer) => void = () => {}
    const { service, file, before } = await kept(
      () => new Promise<MineAnswer>((resolve) => (answer = resolve))
    )
    const read = service.refresh()
    await new Promise((resolve) => setImmediate(resolve))
    service.stop()
    // The fenced connector answers the read that was out as signed out.
    answer(SIGNED_OUT)
    await read
    await service.flushed()
    expect(before).toHaveLength(1)
    expect(file()).toEqual(before)
  })

  it('stay when the connector refuses as signed out while the account is still signed in', async () => {
    const { service, file, before } = await kept(async () => SIGNED_OUT)
    await service.refresh()
    service.stop()
    await service.flushed()
    expect(file()).toEqual(before)
  })

  it('stay when the cloud is unreachable or failing', async () => {
    const { service, file, before } = await kept(async () => ({
      ok: false,
      status: 503,
      error: 'unavailable',
      retryAfterMs: null
    }))
    await service.refresh()
    service.stop()
    await service.flushed()
    expect(file()).toEqual(before)
  })

  it('go when the account signs out', async () => {
    let account: string | null = 'ada'
    const { service } = await kept(
      async () => SIGNED_OUT,
      () => account
    )
    account = null
    await service.refresh()
    service.stop()
    await service.flushed()
    expect(service.store.list()).toEqual([])
  })
})
