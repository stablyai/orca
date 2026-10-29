import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import {
  createInventoryRuntime,
  deferred,
  processRow,
  PREDECESSOR,
  PTY,
  SUCCESSOR,
  WORKTREE,
  type InventoryListing
} from './pty-inventory-lifecycle-fixture'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from './orca-runtime-postlude'

afterEach(() => vi.restoreAllMocks())

describe('lifecycle invalidation respects inventory scope and retry bounds', () => {
  it.each(['remote:unscoped-handle', 'remote:paired-host@@term_guest'])(
    'conservatively rejects pending inventory for foreign lifecycle ID %s',
    async (id) => {
      const reply = deferred<PtyProcessInfo[]>()
      const list = vi.fn<InventoryListing>(() => reply.promise)
      const { runtime, hasPty } = createInventoryRuntime(list)
      const pending = runtime.read('host-b')
      runtime.registerPty(id, WORKTREE)
      reply.resolve([processRow('ssh:host-b@@child')])
      expect(await pending).toBeNull()
      expect(list).toHaveBeenCalledTimes(1)
      expect(list.mock.calls[0][0]).toBe('ssh:host-b')
      expect(hasPty).not.toHaveBeenCalled()
      expect(runtime.capture(id).connected).toBe(true)
    }
  )

  it('preserves a targeted other-host response', async () => {
    const reply = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime(() => reply.promise)
    const pending = runtime.read('host-b')
    runtime.onPtySpawned('ssh:host-a@@child', SUCCESSOR)
    reply.resolve([processRow('ssh:host-b@@child')])
    expect((await pending)?.allLivePtyIds).toEqual(new Set(['ssh:host-b@@child']))
    expect(runtime.capture('ssh:host-b@@child')).toMatchObject({
      connected: true,
      incarnationId: PREDECESSOR
    })
  })

  it.each(['host-a', 'deploy@10.0.0.4:2222', 'ssh target'])(
    'uses explicit host ownership for a legacy unqualified PTY ID on %s',
    async (connectionId) => {
      const reply = deferred<PtyProcessInfo[]>()
      const { runtime } = createInventoryRuntime(() => reply.promise)
      const pending = runtime.read(connectionId)
      runtime.registerPty('legacy-child', WORKTREE, connectionId)
      reply.resolve([processRow('legacy-child')])
      expect(await pending).toBeNull()
      expect(runtime.capture('legacy-child').connected).toBe(true)
    }
  )

  it.each(['deploy@10.0.0.4:2222', 'ssh target'])(
    'rejects stale inventory for an encoding-sensitive qualified PTY ID on %s',
    async (connectionId) => {
      const reply = deferred<PtyProcessInfo[]>()
      const { runtime } = createInventoryRuntime(() => reply.promise)
      const ptyId = `ssh:${connectionId}@@child`
      runtime.registerPty(ptyId, WORKTREE, connectionId)
      const pending = runtime.read(connectionId)
      runtime.onPtySpawned(ptyId, SUCCESSOR)
      reply.resolve([processRow(ptyId)])
      expect(await pending).toBeNull()
      expect(runtime.capture(ptyId)).toMatchObject({
        connected: true,
        incarnationId: SUCCESSOR
      })
    }
  )

  it('does not route an unqualified local admission into an SSH query', async () => {
    const reply = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime(() => reply.promise)
    const pending = runtime.read('host-a')
    runtime.register()
    reply.resolve([processRow('ssh:host-a@@child')])
    expect((await pending)?.allLivePtyIds).toEqual(new Set(['ssh:host-a@@child']))
  })

  it('keeps concurrent targeted provider generations independent', async () => {
    const a = deferred<PtyProcessInfo[]>()
    const b = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime((connection) =>
      connection === 'ssh:a' ? a.promise : b.promise
    )
    const pa = runtime.read('a')
    const pb = runtime.read('b')
    b.resolve([processRow('ssh:b@@child')])
    expect((await pb)?.allLivePtyIds).toEqual(new Set(['ssh:b@@child']))
    a.resolve([processRow('ssh:a@@child')])
    expect((await pa)?.allLivePtyIds).toEqual(new Set(['ssh:a@@child']))
  })

  it('retains ordering between an aggregate and newer targeted inventory', async () => {
    const aggregate = deferred<PtyProcessInfo[]>()
    const targeted = deferred<PtyProcessInfo[]>()
    const { runtime } = createInventoryRuntime((connection) =>
      connection === undefined ? aggregate.promise : targeted.promise
    )
    const pa = runtime.read()
    const pt = runtime.read('a')
    targeted.resolve([processRow('ssh:a@@child', SUCCESSOR)])
    expect(await pt).not.toBeNull()
    aggregate.resolve([processRow('ssh:a@@child', PREDECESSOR)])
    expect(await pa).toBeNull()
    expect(runtime.capture('ssh:a@@child').incarnationId).toBe(SUCCESSOR)
  })

  it('joins a newer aggregate listing instead of re-listing past it', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const second = deferred<PtyProcessInfo[]>()
    const list = vi
      .fn<InventoryListing>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { runtime } = createInventoryRuntime(list)
    const a = runtime.read(undefined, 'repo::/tmp/a')
    const b = runtime.read(undefined, 'repo::/tmp/b')
    first.resolve([processRow('stale-listing')])
    second.resolve([processRow()])
    expect((await a)?.allLivePtyIds).toEqual(new Set([PTY]))
    expect((await b)?.allLivePtyIds).toEqual(new Set([PTY]))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('re-lists instead of joining a newer listing that waits less for slow hosts', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const second = deferred<PtyProcessInfo[]>()
    const list = vi
      .fn<InventoryListing>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue([processRow('relisted')])
    const { runtime } = createInventoryRuntime(list)
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const patient = runtime.read(undefined, 'repo::/tmp/a', 4000)
    const hasty = runtime.read(undefined, 'repo::/tmp/b', 1500)
    first.resolve([processRow('overtaken')])
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3))
    second.resolve([processRow('short-wait')])
    // The patient read re-lists; the hasty one may adopt that longer-waiting listing.
    expect((await patient)?.allLivePtyIds).toEqual(new Set(['relisted']))
    expect((await hasty)?.allLivePtyIds).toEqual(new Set(['relisted']))
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('re-lists instead of joining a newer listing that asked for different process evidence', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const second = deferred<PtyProcessInfo[]>()
    const list = vi
      .fn<InventoryListing>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue([processRow('relisted')])
    const { runtime } = createInventoryRuntime(list)
    const withEvidence = runtime.read(undefined, 'repo::/tmp/a', undefined, {
      includeForegroundProcessEvidence: true
    })
    const without = runtime.read(undefined, 'repo::/tmp/b', undefined, {
      includeForegroundProcessEvidence: false
    })
    first.resolve([processRow('overtaken')])
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3))
    expect(list.mock.calls[2]?.[1]?.includeForegroundProcessEvidence).toBe(true)
    second.resolve([processRow('no-evidence')])
    expect((await withEvidence)?.allLivePtyIds).toEqual(new Set(['relisted']))
    // Overtaken by a listing with evidence, the evidence-free read re-lists rather than adopt it.
    expect((await without)?.allLivePtyIds).toEqual(new Set(['relisted']))
    expect(list).toHaveBeenCalledTimes(4)
    expect(list.mock.calls[3]?.[1]?.includeForegroundProcessEvidence).toBe(false)
  })

  it('caps a deadline-free read at one listing budget however many listings it joins', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const list = vi
      .fn<InventoryListing>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(new Promise<PtyProcessInfo[]>(() => {}))
    const { runtime } = createInventoryRuntime(list)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const pending = runtime.read(undefined, 'repo::/tmp/a')
    void runtime.read(undefined, 'repo::/tmp/b')
    // The first listing answers just before its budget runs out; the joined one never answers.
    now = 1000 + PTY_CONTROLLER_LIST_TIMEOUT_MS - 1
    first.resolve([processRow()])
    const settled = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))
    ])
    expect(settled).toBe('settled')
    expect(await pending).toBeNull()
  })

  it('stops a deadline-free read at its cap while newer listings keep overtaking it', async () => {
    const listings: ReturnType<typeof deferred<PtyProcessInfo[]>>[] = []
    const list = vi.fn<InventoryListing>(() => {
      const listing = deferred<PtyProcessInfo[]>()
      listings.push(listing)
      return listing.promise
    })
    const { runtime } = createInventoryRuntime(list)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let result: unknown = 'pending'
    void runtime.read(undefined, 'repo::/tmp/a').then((value) => (result = value))
    // Each hop: a poller starts a newer listing, then the one the read waits on answers late.
    for (let hop = 1; hop <= 5 && result === 'pending'; hop += 1) {
      void runtime.read(undefined, `repo::/tmp/poller-${hop}`)
      now += 1000
      listings[hop - 1]?.resolve([processRow()])
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(result).toBeNull()
    expect(now - 1000).toBeLessThanOrEqual(PTY_CONTROLLER_LIST_TIMEOUT_MS + 1000)
  })

  it('allows only one target retry and keeps a second invalidation unknown', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const second = deferred<PtyProcessInfo[]>()
    const list = vi
      .fn<InventoryListing>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { runtime } = createInventoryRuntime(list)
    runtime.register()
    const pending = runtime.read(null, WORKTREE, Date.now() + 4000)
    runtime.onPtyExit(PTY, 0, PREDECESSOR, { providerExitObserved: true })
    first.resolve([processRow()])
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    runtime.onPtySpawned(PTY, SUCCESSOR)
    second.resolve([])
    expect(await pending).toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
    expect(runtime.capture()).toMatchObject({ connected: true, incarnationId: SUCCESSOR })
  })

  it('retries with the original remaining deadline and accepts fresh truth', async () => {
    const first = deferred<PtyProcessInfo[]>()
    const list = vi.fn<InventoryListing>().mockReturnValueOnce(first.promise).mockResolvedValue([])
    const { runtime } = createInventoryRuntime(list)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    runtime.register()
    const pending = runtime.read(null, WORKTREE, 1500)
    runtime.onPtyExit(PTY, 0, PREDECESSOR, { providerExitObserved: true })
    now = 1400
    first.resolve([processRow()])
    expect((await pending)?.allLivePtyIds).toEqual(new Set())
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1][1]?.deadlineMs).toBeLessThanOrEqual(1500)
    expect(runtime.capture().connected).toBe(false)
  })
})
