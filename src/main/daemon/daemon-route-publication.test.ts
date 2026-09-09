import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import { createAdapter } from './daemon-pty-router-test-adapter'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const row = (id: string, incarnationId?: string): PtyProcessInfo => ({
  id,
  incarnationId,
  cwd: '',
  title: ''
})

describe('authoritative route publication', () => {
  it.each(['discovery', 'probe'])(
    'fences delayed %s against same-ID wake without blocking other IDs',
    async (source) => {
      const legacy = createAdapter('legacy', ['session'], 29)
      const current = createAdapter('current', [], 36)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      await router.discoverLegacySessions()
      const captured = gate<void>()
      const delayed = gate<void>()
      vi.mocked(legacy.listProcesses).mockImplementationOnce(async () => {
        captured.resolve()
        await delayed.promise
        return [row('session', 'old')]
      })
      const pending =
        source === 'probe'
          ? router.probePtyLiveness('other-missing')
          : router.discoverLegacySessions()
      await captured.promise
      await router.shutdown('session', { keepHistory: true })
      await router.spawn({ sessionId: 'session', cols: 80, rows: 24 })
      await router.spawn({ sessionId: 'different', cols: 80, rows: 24 })
      delayed.resolve()
      await pending
      router.write('session', 'new-owner')
      expect(current.write).toHaveBeenCalledWith('session', 'new-owner')
      expect(legacy.write).not.toHaveBeenCalled()
      router.disposeRouterOnly()
    }
  )

  it('does not delete a new incarnation after a delayed false direct probe', async () => {
    const owner = createAdapter('owner', [], 36)
    const router = new DaemonPtyRouter({ current: owner, legacy: [] })
    await router.spawn({ sessionId: 'session', cols: 80, rows: 24 })
    const delayed = gate<boolean>()
    vi.mocked(owner.probePtyLiveness).mockReturnValueOnce(delayed.promise)
    const probe = router.probePtyLiveness('session')
    vi.mocked(owner.spawn).mockResolvedValueOnce({ id: 'session', incarnationId: 'new' })
    await router.spawn({ sessionId: 'session', cols: 80, rows: 24 })
    delayed.resolve(false)
    expect(await probe).toBeNull()
    expect(router.providesAgentSessionOwnerListings('session')).toBe(true)
    router.disposeRouterOnly()
  })

  it('does not resurrect an exited session from an inventory begun before its first route', async () => {
    const owner = createAdapter('owner', [], 36)
    const routes = new Map<string, IPtyProvider>()
    const resolver = new DaemonSessionOwnerResolver([owner], routes)
    const delayed = gate<PtyProcessInfo[]>()
    vi.mocked(owner.listProcesses).mockReturnValueOnce(delayed.promise)
    const discovery = resolver.discoverRoutes()
    await resolver.authority.exited('session', owner, 'old')
    delayed.resolve([row('session', 'old')])
    await discovery
    expect(routes.has('session')).toBe(false)
  })

  it('queues exits behind spawn and rejects the predecessor incarnation', async () => {
    const owner = createAdapter('owner', [], 36)
    const router = new DaemonPtyRouter({ current: owner, legacy: [] })
    const entered = gate<void>()
    const delayed = gate<void>()
    vi.mocked(owner.spawn).mockImplementationOnce(async () => {
      entered.resolve()
      await delayed.promise
      return { id: 'session', incarnationId: 'new' }
    })
    const spawn = router.spawn({ sessionId: 'session', cols: 80, rows: 24 })
    await entered.promise
    owner.emitExit('session', 0, 'old')
    delayed.resolve()
    await spawn
    await vi.waitFor(() => expect(router.providesAgentSessionOwnerListings('session')).toBe(true))
    owner.emitExit('session', 0, 'old')
    expect(router.providesAgentSessionOwnerListings('session')).toBe(true)
    owner.emitExit('session', 0, 'new')
    await vi.waitFor(() => expect(router.providesAgentSessionOwnerListings('session')).toBe(false))
    router.disposeRouterOnly()
  })

  it.each(['disposeRouterOnly', 'disconnectOnly'] as const)(
    'rejects late spawn and inventory after %s',
    async (method) => {
      const owner = createAdapter('owner', [], 36)
      const router = new DaemonPtyRouter({ current: owner, legacy: [] })
      const delayed = gate<void>()
      const entered = gate<void>()
      vi.mocked(owner.spawn).mockImplementationOnce(async () => {
        entered.resolve()
        await delayed.promise
        return { id: 'session', incarnationId: 'old' }
      })
      const result = router
        .spawn({ sessionId: 'session', cols: 80, rows: 24 })
        .catch((error) => error)
      await entered.promise
      const inventory = gate<PtyProcessInfo[]>()
      vi.mocked(owner.listProcesses).mockReturnValueOnce(inventory.promise)
      const discovery = router.discoverLegacySessions()
      await router[method]()
      delayed.resolve()
      inventory.resolve([row('session', 'old')])
      expect(await result).toMatchObject({ name: 'TerminalSessionOwnerUnverifiedError' })
      await discovery
      expect(router.providesAgentSessionOwnerListings('session')).toBe(false)
    }
  )

  it.each(['matching', 'different', 'newer-route', 'disconnect'])(
    'requires fresh incarnation proof after provider invalidation: %s',
    async (control) => {
      const owner = createAdapter('owner', [], 36)
      const routes = new Map<string, IPtyProvider>()
      const resolver = new DaemonSessionOwnerResolver([owner], routes)
      const refresh = gate<PtyProcessInfo[]>()
      const entered = gate<void>()
      vi.mocked(owner.spawn).mockImplementationOnce(async () => {
        resolver.invalidateProvider(owner)
        return { id: 'session', incarnationId: 'new', isReattach: true }
      })
      vi.mocked(owner.listProcesses).mockImplementationOnce(() => {
        entered.resolve()
        return refresh.promise
      })
      const result = resolver
        .runWithCustody('session', (admission) =>
          resolver.spawnAttachOnly(
            { sessionId: 'session', attachOnly: true, cols: 80, rows: 24 },
            admission
          )
        )
        .catch((error) => error)
      await entered.promise
      if (control === 'newer-route') {
        resolver.recordRoute('session', owner, 'newer')
      }
      if (control === 'disconnect') {
        resolver.authority.dispose()
      }
      refresh.resolve([row('session', control === 'different' ? 'different' : 'new')])
      if (control === 'matching') {
        expect(await result).toMatchObject({ incarnationId: 'new' })
        expect(routes.get('session')).toBe(owner)
      } else {
        expect(await result).toMatchObject({ name: 'TerminalSessionOwnerUnverifiedError' })
        expect(resolver.authority.incarnation('session')).toBe(
          control === 'newer-route' ? 'newer' : undefined
        )
      }
    }
  )
  it('does not refresh over a route committed before the invalidated spawn reply', async () => {
    const owner = createAdapter('owner', [], 36)
    const routes = new Map<string, IPtyProvider>()
    const resolver = new DaemonSessionOwnerResolver([owner], routes)
    vi.mocked(owner.spawn).mockImplementationOnce(async () => {
      resolver.invalidateProvider(owner)
      resolver.recordRoute('session', owner, 'newer')
      return { id: 'session', incarnationId: 'old', isReattach: true }
    })
    await expect(
      resolver.runWithCustody('session', (admission) =>
        resolver.spawnAttachOnly(
          { sessionId: 'session', attachOnly: true, cols: 80, rows: 24 },
          admission
        )
      )
    ).rejects.toMatchObject({ name: 'TerminalSessionOwnerUnverifiedError' })
    expect(owner.listProcesses).not.toHaveBeenCalled()
    expect(resolver.authority.incarnation('session')).toBe('newer')
  })
})
