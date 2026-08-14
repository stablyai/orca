import { describe, expect, it, vi } from 'vitest'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

function provider(
  processes: () => Promise<PtyProcessInfo[]>,
  spawn: (opts: PtySpawnOptions) => Promise<PtySpawnResult> = async (opts) => ({
    id: opts.sessionId ?? 'new'
  })
): IPtyProvider {
  return {
    listProcesses: vi.fn(processes),
    spawn: vi.fn(spawn)
  } as unknown as IPtyProvider
}

describe('DaemonSessionOwnerResolver', () => {
  it('reattaches a held daemon\u2019s session once the daemon stops being wedged', async () => {
    // Pins a promise the degraded notice makes to the user: "reopening a pane retries, and works
    // once it does". In held mode discovery ran over the same IPC the daemon was failing, so no
    // route was ever recorded — recovery therefore cannot come from a cached route. It has to
    // come from the next attach re-inventorying a provider whose failure cooldown has expired.
    const session = 'wt-1@@pane-1'
    let wedged = true
    const daemonInventory = vi.fn(async () => {
      if (wedged) {
        throw new Error('Hello response timed out')
      }
      return [{ id: session, cwd: '/repo' }] as PtyProcessInfo[]
    })
    const fallback = provider(async () => [])
    const daemon = provider(daemonInventory, async (opts) => ({
      id: opts.sessionId as string,
      isReattach: true
    }))
    const resolver = new DaemonSessionOwnerResolver([fallback, daemon], new Map())

    // While wedged the session cannot be proven to belong to anyone, and the resolver refuses
    // rather than letting the fallback answer with a fresh shell.
    await expect(
      resolver.spawnAttachOnly({ sessionId: session, attachOnly: true } as never)
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)

    wedged = false
    await new Promise((resolve) => setTimeout(resolve, 1_100)) // outlast FAILED_PROVIDER_COOLDOWN_MS

    const result = await resolver.spawnAttachOnly({ sessionId: session, attachOnly: true } as never)
    expect(result.id).toBe(session)
    expect(daemon.spawn).toHaveBeenCalledTimes(1)
  })

  it('coalesces complete multi-provider absence without dispatching an attach', async () => {
    let releaseFallback!: (processes: PtyProcessInfo[]) => void
    let releaseCurrent!: (processes: PtyProcessInfo[]) => void
    let releaseLegacy!: (processes: PtyProcessInfo[]) => void
    const fallbackGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseFallback = resolve
    })
    const currentGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseCurrent = resolve
    })
    const legacyGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseLegacy = resolve
    })
    const fallbackInventory = vi.fn(() => fallbackGate)
    const currentInventory = vi.fn(() => currentGate)
    const legacyInventory = vi.fn(() => legacyGate)
    const fallback = provider(fallbackInventory)
    const current = provider(currentInventory)
    const legacy = provider(legacyInventory)
    const resolver = new DaemonSessionOwnerResolver([fallback, current, legacy], new Map())

    const resolutions = [
      resolver.spawnAttachOnly({
        sessionId: 'pty-persisted-alpha',
        expectedIncarnationId: 'incarnation-persisted-alpha',
        attachOnly: true,
        cols: 80,
        rows: 24
      }),
      resolver.spawnAttachOnly({
        sessionId: 'pty-persisted-beta',
        expectedIncarnationId: 'incarnation-persisted-beta',
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ]
    let settled = 0
    for (const resolution of resolutions) {
      void resolution.then(
        () => {
          settled += 1
        },
        () => {
          settled += 1
        }
      )
    }

    expect(fallbackInventory).toHaveBeenCalledOnce()
    expect(currentInventory).toHaveBeenCalledOnce()
    expect(legacyInventory).toHaveBeenCalledOnce()
    releaseFallback([])
    releaseCurrent([])
    for (let iteration = 0; iteration < 10; iteration += 1) {
      await Promise.resolve()
    }
    expect(settled).toBe(0)
    expect(fallback.spawn).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
    releaseLegacy([])

    const results = await Promise.allSettled(resolutions)
    expect(results).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.any(SessionNotFoundError)
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.any(SessionNotFoundError)
      })
    ])
    expect(settled).toBe(2)
    expect(fallbackInventory).toHaveBeenCalledOnce()
    expect(currentInventory).toHaveBeenCalledOnce()
    expect(legacyInventory).toHaveBeenCalledOnce()
    expect(fallback.spawn).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'pty-persisted-alpha',
        expectedIncarnationId: 'incarnation-persisted-alpha',
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(fallbackInventory).toHaveBeenCalledTimes(2)
    expect(currentInventory).toHaveBeenCalledTimes(2)
    expect(legacyInventory).toHaveBeenCalledTimes(2)
    expect(fallback.spawn).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('bounds restore inventory requests across many panes and daemon generations', async () => {
    const inventories = Array.from({ length: 51 }, (_, index) =>
      vi.fn(async () => {
        if (index === 50) {
          throw new Error('offline')
        }
        return []
      })
    )
    const resolver = new DaemonSessionOwnerResolver(
      inventories.map((inventory) => provider(inventory)),
      new Map()
    )

    for (let index = 0; index < 40; index += 1) {
      await resolver.resolve(`pane-${index}`)
    }

    for (const inventory of inventories) {
      expect(inventory).toHaveBeenCalledOnce()
    }
  })

  it('reuses incomplete inventory across serialized restores', async () => {
    const firstInventory = vi.fn(async () => [])
    const secondInventory = vi.fn(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver(
      [provider(firstInventory), provider(secondInventory)],
      new Map()
    )

    await resolver.resolve('first')
    await resolver.resolve('second')

    expect(firstInventory).toHaveBeenCalledOnce()
    expect(secondInventory).toHaveBeenCalledOnce()
  })

  it('does not extend incomplete inventory lifetime on cache hits', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const inventory = vi.fn(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver(
      [provider(async () => []), provider(inventory)],
      new Map()
    )

    try {
      await resolver.resolve('first')
      now += 900
      await resolver.resolve('second')
      now += 101
      await resolver.resolve('third')

      expect(inventory).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('does not let startup inventory hide a session created before restore', async () => {
    const sessions: PtyProcessInfo[] = []
    const inventory = vi.fn(async () => sessions)
    const owner = provider(inventory, async (opts) => ({
      id: opts.sessionId!,
      incarnationId: 'live',
      isReattach: true
    }))
    const resolver = new DaemonSessionOwnerResolver([owner, provider(async () => [])], new Map())

    await resolver.discoverRoutes()
    sessions.push({ id: 'session', incarnationId: 'live', cwd: '', title: 'live' })

    await expect(
      resolver.spawnAttachOnly({ sessionId: 'session', attachOnly: true, cols: 80, rows: 24 })
    ).resolves.toMatchObject({ id: 'session', incarnationId: 'live', isReattach: true })
    expect(inventory).toHaveBeenCalledTimes(2)
  })

  it('uses the expected incarnation to disambiguate duplicate session ids', async () => {
    const oldOwner = provider(async () => [
      { id: 'session', incarnationId: 'old', cwd: '', title: 'old' }
    ])
    const exactOwner = provider(async () => [
      { id: 'session', incarnationId: 'expected', cwd: '', title: 'exact' }
    ])
    const resolver = new DaemonSessionOwnerResolver([oldOwner, exactOwner], new Map())

    await expect(resolver.resolve('session', 'expected')).resolves.toMatchObject({
      kind: 'owner',
      provider: exactOwner
    })
  })

  it('accepts one exact-id owner when persisted incarnation evidence is stale', async () => {
    const liveOwner = provider(async () => [
      { id: 'session', incarnationId: 'live', cwd: '', title: 'live' }
    ])
    const resolver = new DaemonSessionOwnerResolver([liveOwner], new Map())

    await expect(resolver.resolve('session', 'stale')).resolves.toMatchObject({
      kind: 'owner',
      provider: liveOwner
    })
  })

  it('does not inventory unrelated providers for a routed stale persisted incarnation', async () => {
    const routedOwner = provider(
      async () => [{ id: 'session', incarnationId: 'live', cwd: '', title: 'live' }],
      async () => ({ id: 'session', incarnationId: 'live', isReattach: true })
    )
    const unrelatedInventory = vi.fn(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver(
      [routedOwner, provider(unrelatedInventory)],
      new Map([['session', routedOwner]])
    )

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'session',
        expectedIncarnationId: 'stale',
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'session', incarnationId: 'live', isReattach: true })
    expect(unrelatedInventory).not.toHaveBeenCalled()
  })

  it('re-resolves a routed incarnation mismatch against every possible owner', async () => {
    const staleRoute = provider(
      async () => [{ id: 'session', incarnationId: 'other', cwd: '', title: 'stale' }],
      async () => ({ id: 'session', incarnationId: 'other', isReattach: true })
    )
    const exactOwner = provider(
      async () => [{ id: 'session', incarnationId: 'expected', cwd: '', title: 'exact' }],
      async () => ({ id: 'session', incarnationId: 'expected', isReattach: true })
    )
    const resolver = new DaemonSessionOwnerResolver(
      [staleRoute, exactOwner],
      new Map([['session', staleRoute]])
    )

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'session',
        expectedIncarnationId: 'expected',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ incarnationId: 'expected' })
    expect(staleRoute.spawn).not.toHaveBeenCalled()
  })

  it('refreshes incomplete inventory when a routed owner refuses a moved session', async () => {
    let firstOwnsSession = true
    let secondOwnsSession = false
    const first = provider(
      async () =>
        firstOwnsSession
          ? [{ id: 'session', incarnationId: 'runtime', cwd: '', title: 'first' }]
          : [],
      async () => {
        throw new SessionNotFoundError('session')
      }
    )
    const second = provider(
      async () =>
        secondOwnsSession
          ? [{ id: 'session', incarnationId: 'runtime', cwd: '', title: 'second' }]
          : [],
      async () => ({ id: 'session', incarnationId: 'runtime', isReattach: true })
    )
    const unavailable = provider(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver([first, second, unavailable], new Map())

    await expect(resolver.resolve('session', 'runtime', true)).resolves.toMatchObject({
      kind: 'owner',
      provider: first
    })
    firstOwnsSession = false
    secondOwnsSession = true

    await expect(
      resolver.spawnAttachOnly({
        sessionId: 'session',
        expectedIncarnationId: 'runtime',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'session', incarnationId: 'runtime', isReattach: true })
    expect(first.spawn).toHaveBeenCalledOnce()
    expect(second.spawn).toHaveBeenCalledOnce()
    expect(second.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('accepts exact runtime proof from an incomplete inventory', async () => {
    const exactOwner = provider(async () => [
      { id: 'session', incarnationId: 'runtime', cwd: '', title: 'exact' }
    ])
    const resolver = new DaemonSessionOwnerResolver(
      [
        exactOwner,
        provider(async () => {
          throw new Error('offline')
        })
      ],
      new Map()
    )

    await expect(resolver.resolve('session', 'runtime', true)).resolves.toMatchObject({
      kind: 'owner',
      provider: exactOwner
    })
  })

  it('does not trust persisted incarnation proof from an incomplete inventory', async () => {
    const resolver = new DaemonSessionOwnerResolver(
      [
        provider(async () => [
          { id: 'session', incarnationId: 'persisted', cwd: '', title: 'candidate' }
        ]),
        provider(async () => {
          throw new Error('offline')
        })
      ],
      new Map()
    )

    await expect(resolver.resolve('session', 'persisted')).resolves.toEqual({ kind: 'unknown' })
  })

  it('accepts positive liveness proof from an incomplete inventory', async () => {
    const resolver = new DaemonSessionOwnerResolver(
      [
        provider(async () => [{ id: 'session', cwd: '', title: 'live' }]),
        provider(async () => {
          throw new Error('offline')
        })
      ],
      new Map()
    )

    await expect(resolver.probe('session')).resolves.toBe(true)
  })

  it('fails closed when duplicate owners cannot be disambiguated', async () => {
    const first = provider(async () => [{ id: 'session', cwd: '', title: 'first' }])
    const second = provider(async () => [{ id: 'session', cwd: '', title: 'second' }])
    const resolver = new DaemonSessionOwnerResolver([first, second], new Map())

    await expect(resolver.resolve('session')).resolves.toEqual({ kind: 'unknown' })
    expect(first.listProcesses).toHaveBeenCalledOnce()
    expect(second.listProcesses).toHaveBeenCalledOnce()
    expect(first.spawn).not.toHaveBeenCalled()
    expect(second.spawn).not.toHaveBeenCalled()
  })

  it('reports confirmed absence from a sole owner', async () => {
    const owner = provider(
      async () => [],
      async () => {
        throw new SessionNotFoundError('missing')
      }
    )
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())

    await expect(
      resolver.spawnAttachOnly({ sessionId: 'missing', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(owner.spawn).toHaveBeenCalledOnce()
    expect(owner.listProcesses).not.toHaveBeenCalled()
  })

  it('keeps absence unverified when there are no possible owners', async () => {
    const resolver = new DaemonSessionOwnerResolver([], new Map())

    await expect(resolver.resolve('missing')).resolves.toEqual({ kind: 'unknown' })
  })

  it('preserves an unresolved owner when any provider inventory fails', async () => {
    const reachable = provider(async () => [])
    const unreachable = provider(async () => {
      throw new Error('offline')
    })
    const resolver = new DaemonSessionOwnerResolver([reachable, unreachable], new Map())

    await expect(
      resolver.spawnAttachOnly({ sessionId: 'missing', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(reachable.listProcesses).toHaveBeenCalledOnce()
    expect(unreachable.listProcesses).toHaveBeenCalledOnce()
    expect(reachable.spawn).not.toHaveBeenCalled()
    expect(unreachable.spawn).not.toHaveBeenCalled()
  })

  it('does not turn a raced owner refusal into absence while another provider is unresolved', async () => {
    const candidate = provider(
      async () => [{ id: 'session', cwd: '', title: 'candidate' }],
      async () => {
        throw new SessionNotFoundError('session')
      }
    )
    const resolver = new DaemonSessionOwnerResolver(
      [
        candidate,
        provider(async () => {
          throw new Error('offline')
        })
      ],
      new Map()
    )

    await expect(
      resolver.spawnAttachOnly({ sessionId: 'session', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(candidate.listProcesses).toHaveBeenCalledOnce()
    expect(candidate.spawn).not.toHaveBeenCalled()
  })

  it('does not turn a post-inventory owner refusal into aggregate absence', async () => {
    const candidate = provider(
      async () => [{ id: 'session', cwd: '', title: 'candidate' }],
      async () => {
        throw new SessionNotFoundError('session')
      }
    )
    const resolver = new DaemonSessionOwnerResolver(
      [candidate, provider(async () => [])],
      new Map()
    )

    await expect(
      resolver.spawnAttachOnly({ sessionId: 'session', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(candidate.listProcesses).toHaveBeenCalledOnce()
    expect(candidate.spawn).toHaveBeenCalledOnce()
  })

  it('pre-routes every uniquely inventoried session for serialized restores', async () => {
    const inventory = vi.fn(async () => [
      { id: 'first', cwd: '', title: 'first' },
      { id: 'second', cwd: '', title: 'second' }
    ])
    const owner = provider(inventory)
    const emptyInventory = vi.fn(async () => [])
    const resolver = new DaemonSessionOwnerResolver([owner, provider(emptyInventory)], new Map())

    await resolver.spawnAttachOnly({ sessionId: 'first', attachOnly: true, cols: 80, rows: 24 })
    await resolver.spawnAttachOnly({ sessionId: 'second', attachOnly: true, cols: 80, rows: 24 })

    expect(inventory).toHaveBeenCalledOnce()
    expect(emptyInventory).toHaveBeenCalledOnce()
  })

  it('discards an inventory completed after daemon identity replacement', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inventory = vi.fn(async () => {
      await gate
      return [{ id: 'session', cwd: '', title: 'stale' }]
    })
    const owner = provider(inventory)
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())

    const resolution = resolver.resolve('session')
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledOnce())
    resolver.invalidateProvider(owner)
    release()

    await expect(resolution).resolves.toEqual({ kind: 'unknown' })
    await resolver.resolve('session')
    expect(inventory).toHaveBeenCalledTimes(2)
  })

  it('fails closed across identity replacement then confirms absence on retry', async () => {
    let releaseCurrent!: (processes: PtyProcessInfo[]) => void
    let releaseLegacy!: (processes: PtyProcessInfo[]) => void
    const currentGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseCurrent = resolve
    })
    const legacyGate = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseLegacy = resolve
    })
    const currentInventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockReturnValueOnce(currentGate)
      .mockResolvedValueOnce([])
    const legacyInventory = vi
      .fn<() => Promise<PtyProcessInfo[]>>()
      .mockReturnValueOnce(legacyGate)
      .mockResolvedValueOnce([])
    const current = provider(currentInventory)
    const legacy = provider(legacyInventory)
    const resolver = new DaemonSessionOwnerResolver([current, legacy], new Map())
    const attach = {
      sessionId: 'pty-persisted-after-identity-change',
      expectedIncarnationId: 'incarnation-before-identity-change',
      attachOnly: true,
      cols: 80,
      rows: 24
    } as const

    const staleAttempt = resolver.spawnAttachOnly(attach)
    expect(currentInventory).toHaveBeenCalledOnce()
    expect(legacyInventory).toHaveBeenCalledOnce()
    resolver.invalidateProvider(current)
    releaseCurrent([])
    releaseLegacy([])

    await expect(staleAttempt).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()

    await expect(resolver.spawnAttachOnly(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(currentInventory).toHaveBeenCalledTimes(2)
    expect(legacyInventory).toHaveBeenCalledTimes(2)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })

  it('restores a proven route when identity changes during exact reattach', async () => {
    const routes = new Map<string, IPtyProvider>()
    let resolver!: DaemonSessionOwnerResolver<IPtyProvider>
    let owner!: IPtyProvider
    owner = provider(
      async () => [],
      async () => {
        resolver.invalidateProvider(owner)
        return { id: 'session', incarnationId: 'inc', isReattach: true }
      }
    )
    routes.set('session', owner)
    resolver = new DaemonSessionOwnerResolver([owner], routes)

    await resolver.spawnAttachOnly({ sessionId: 'session', attachOnly: true, cols: 80, rows: 24 })

    expect(routes.get('session')).toBe(owner)
  })
})
