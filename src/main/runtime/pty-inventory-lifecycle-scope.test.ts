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
      expect(list.mock.calls[0][0]).toBe('host-b')
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
      connection === 'a' ? a.promise : b.promise
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
