import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedBotHostsState } from '../../../shared/bots/shared-bot-hosts'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { ConnectorAccountTransport } from '../../connector-cloud/connector-transport'
import { SharedBotHosts } from './shared-bot-hosts'
import { sharedBotsCloud } from './shared-bots-cloud'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

type Reply = 'shares' | 'not-found' | 'unreachable' | Promise<'shares'>

/** The account's SharedBotHosts over the real shares client and connector transport; each read of
 *  the shares route gets the next reply. */
function sharingHosts(replies: Reply[], account: () => string | null = () => 'ada') {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-sharing-'))
  dirs.push(dir)
  let fetches = 0
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    expect(String(input)).toBe('https://cloud.test/v1/shares/mine')
    fetches += 1
    const reply = await replies.shift()
    if (reply === 'unreachable') {
      throw new TypeError('fetch failed')
    }
    return reply === 'shares'
      ? Response.json({ v: 1, shares: [] })
      : Response.json({ error: 'not_found' }, { status: 404 })
  }
  const transport = new ConnectorAccountTransport(
    'https://cloud.test',
    async () => ({ ok: true, value: { connectorToken: 't', expiresAt: Number.MAX_SAFE_INTEGER } }),
    fetchImpl
  )
  const published: SharedBotHostsState[] = []
  const hosts = new SharedBotHosts({
    userDataPath: dir,
    account,
    cloud: () => sharedBotsCloud(transport),
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: (state) => published.push(state),
    homes: memorySharedBotHomes(dir).homes,
    now: () => 0
  })
  return { hosts, published, fetches: () => fetches }
}

describe('whether this account’s Orca Cloud takes shares', () => {
  it('says yes on a shares answer, no on an older cloud’s 404, and keeps it when the cloud is unreachable', async () => {
    const { hosts, published } = sharingHosts([
      'unreachable',
      'shares',
      'unreachable',
      'not-found',
      'unreachable'
    ])
    const read = async (): Promise<boolean | null> => {
      await hosts.refresh()
      return published.at(-1)!.sharing
    }
    try {
      expect(await read()).toBeNull()
      expect(await read()).toBe(true)
      expect(await read()).toBe(true)
      expect(await read()).toBe(false)
      expect(await read()).toBe(false)
    } finally {
      hosts.stop()
      await hosts.flushed()
    }
  })

  it('forgets one account’s answer when another signs in, even when its read fails', async () => {
    let account = 'ada'
    const { hosts, published } = sharingHosts(['shares', 'unreachable', 'shares'], () => account)
    try {
      await hosts.refresh()
      expect(published.at(-1)!.sharing).toBe(true)
      account = 'grace'
      await hosts.refresh()
      expect(published.map((state) => state.sharing)).toEqual([true, null, null])
      await hosts.refresh()
      expect(published.at(-1)!.sharing).toBe(true)
    } finally {
      hosts.stop()
      await hosts.flushed()
    }
  })

  it('hides sharing as soon as another account signs in, while a read as the last one is still out', async () => {
    let account = 'ada'
    let answerLate: (reply: 'shares') => void = () => {}
    const late = new Promise<'shares'>((resolve) => {
      answerLate = resolve
    })
    const { hosts, published, fetches } = sharingHosts(
      ['shares', late, 'unreachable'],
      () => account
    )
    try {
      await hosts.refresh()
      expect(published.at(-1)!.sharing).toBe(true)
      const outstanding = hosts.refresh()
      await vi.waitFor(() => expect(fetches()).toBe(2))
      account = 'grace'
      void hosts.refresh()
      const switchedAt = published.length
      expect(published.at(-1)!.sharing).toBeNull()
      // The last account's answer lands after the switch and is not taken as this one's.
      answerLate('shares')
      await outstanding
      expect(fetches()).toBe(3)
      expect(published.slice(switchedAt).map((state) => state.sharing)).not.toContain(true)
      expect(published.at(-1)!.sharing).toBeNull()
    } finally {
      hosts.stop()
      await hosts.flushed()
    }
  })

  it('says no without an Orca Cloud', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-sharing-'))
    dirs.push(dir)
    const published: SharedBotHostsState[] = []
    const hosts = new SharedBotHosts({
      userDataPath: dir,
      account: () => 'ada',
      cloud: () => null,
      platform: NODE_RELAY_CLIENT_PLATFORM,
      publish: (state) => published.push(state),
      homes: memorySharedBotHomes(dir).homes,
      now: () => 0
    })
    await hosts.refresh()
    hosts.stop()
    expect(published.at(-1)?.sharing).toBe(false)
  })
})
