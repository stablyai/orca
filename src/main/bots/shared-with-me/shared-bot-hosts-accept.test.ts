// A share offered to this account waits for its Accept: nothing of it is kept or paired before, a
// Decline is kept for good, and a share accepted before Accept existed stays as it was.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorSharesMineSchema } from '../../../shared/connector-share-contract'
import { agentCardAvatar } from '../../../shared/bots/shared-agent-card'
import { SharedBotHosts } from './shared-bot-hosts'
import { newSharedBotHostEntry, SharedBotHostStore } from './shared-bot-host-store'
import type { MineShare } from './shared-bot-pairing'
import { sharedBotsCloud, type SharedBotOfferWait, type SharedBotsCloud } from './shared-bots-cloud'
import { reportingSharedBotsCloud, SharedBotHostFailures } from './shared-bot-host-failures'
import { requestConnector } from '../../connector-cloud/connector-cloud-request'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'

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
function hosts(
  dir = mkdtempSync(join(tmpdir(), 'shared-bot-accept-')),
  options: { now?: () => number; waited?: () => Promise<void>; shares?: MineShare[] } = {}
) {
  const shares = options.shares ?? [offered]
  dirs.push(dir)
  const accepts: string[] = []
  const declines: string[] = []
  // Each share-list read, with the offer it waited for, if any.
  const reads: (SharedBotOfferWait | undefined)[] = []
  const cloud: SharedBotsCloud = {
    mine: async (wait) => {
      reads.push(wait)
      if (wait) {
        await options.waited?.()
      }
      return { ok: true, value: { v: 1, shares } }
    },
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
    publish: () => {},
    now: options.now ?? (() => 1_000)
  })
  return { service, accepts, declines, dir, reads }
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

  it("draws the card a newer cloud lists, and the agent's initial from an older one", async () => {
    // As each cloud answers: a newer one with the owner's card, an older one with none.
    const { shares } = ConnectorSharesMineSchema.parse({
      v: 1,
      shares: [
        { ...offered, agentCard: { mascot: 'H1', color: '#f4c4cf', services: ['github'] } },
        { ...offered, shareId: 'share-2' }
      ]
    })
    const { service } = hosts(undefined, { shares })
    await service.refresh()
    service.stop()
    const [carded, plain] = service.state().requests ?? []
    expect(agentCardAvatar(carded?.agentCard)).toEqual({
      avatar: 'mascot:H1',
      avatarColor: '#f4c4cf'
    })
    expect(carded?.agentCard?.services).toEqual(['github'])
    expect(plain).not.toHaveProperty('agentCard')
    expect(agentCardAvatar(plain?.agentCard)).toEqual({ avatar: null })
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

  it("after Accept, makes one read that waits for the host's offer, connecting until it answers", async () => {
    vi.useFakeTimers()
    try {
      let answer = () => {}
      const { service, reads } = hosts(undefined, {
        now: () => Date.now(),
        waited: () => new Promise((resolve) => (answer = resolve))
      })
      await service.refresh()
      await service.accept('share-1')
      await vi.advanceTimersByTimeAsync(0)
      const device = service.store.get('share-1')?.deviceKey.publicKeyB64
      expect(reads.at(-1)).toEqual({ shareId: 'share-1', devicePublicKey: device })
      expect(service.views()[0]?.accepting).toBe(true)
      // The cloud holds it until the host's offer is on the share.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(service.views()[0]?.accepting).toBe(true)
      answer()
      await vi.advanceTimersByTimeAsync(0)
      service.stop()
      expect(service.views()[0]?.accepting).toBe(false)
      expect(reads.filter(Boolean)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('on a cloud that answers the wait at once with no offer: away, then the usual 30 s pace, no loop', async () => {
    vi.useFakeTimers()
    try {
      const { service, reads } = hosts(undefined, { now: () => Date.now() })
      await service.refresh()
      await service.accept('share-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(service.views()[0]?.accepting).toBe(false)
      const settled = reads.length
      await vi.advanceTimersByTimeAsync(29_000)
      expect(reads.length).toBe(settled)
      await vi.advanceTimersByTimeAsync(1_000)
      service.stop()
      expect(reads.length).toBe(settled + 1)
      expect(reads.filter(Boolean)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("over the wire as wired in the app: the cloud's 202 to Accept is the next read's wait", async () => {
    vi.useFakeTimers()
    try {
      // The cloud as it answered in production: Accept 202, the host's offer on the share 0.4 s later,
      // and a read naming the share held until then.
      const requests: string[] = []
      let offerLanded = false
      let landOffer = () => {}
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input))
        requests.push(`${init?.method} ${url.pathname}${url.search}`)
        if (url.pathname.endsWith('/accept')) {
          setTimeout(() => {
            offerLanded = true
            landOffer()
          }, 400)
          return new Response(JSON.stringify({ status: 'queued' }), { status: 202 })
        }
        if (url.searchParams.has('waitShare') && !offerLanded) {
          await new Promise<void>((resolve) => (landOffer = resolve))
        }
        return new Response(JSON.stringify({ v: 1, shares: [offered] }), { status: 200 })
      }
      const call: ConnectorCloud['call'] = async (path, body, schema, options) =>
        requestConnector(
          {
            fetchImpl,
            url: `https://cloud.test${path}`,
            body,
            method: options?.method,
            timeoutMs: options?.timeoutMs
          },
          schema
        )
      const cloud = reportingSharedBotsCloud(
        sharedBotsCloud({
          call,
          readShares: (path, schema, options) =>
            call(path, undefined, schema, { ...options, method: 'GET' })
        }),
        new SharedBotHostFailures()
      )
      const dir = mkdtempSync(join(tmpdir(), 'shared-bot-accept-'))
      dirs.push(dir)
      const service = new SharedBotHosts({
        userDataPath: dir,
        account: () => 'ada',
        cloud: () => cloud,
        publish: () => {},
        now: () => Date.now()
      })
      await service.refresh()
      await service.accept('share-1')
      await vi.advanceTimersByTimeAsync(0)
      const device = encodeURIComponent(service.store.get('share-1')?.deviceKey.publicKeyB64 ?? '')
      expect(service.store.get('share-1')?.acceptedAt).toBeDefined()
      expect(requests.at(-1)).toBe(`GET /v1/shares/mine?waitShare=share-1&device=${device}`)
      expect(service.views()[0]?.accepting).toBe(true)
      await vi.advanceTimersByTimeAsync(400)
      service.stop()
      expect(service.views()[0]?.accepting).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
