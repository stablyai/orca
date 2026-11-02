import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { PreparedAgentLaunchRoutes } from './daemon-prepared-agent-launch-routing'
import type { PreparedAgentLaunchRequest } from './prepared-agent-launch-protocol'

const claim = {
  kind: 'fresh-launch',
  agent: 'codex',
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  digestVersion: 1
} as const
const surface = {
  worktreeId: 'wt',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_agent'
}

function daemon(initialGeneration: string, stalled = false) {
  let generation = initialGeneration
  const identityChanged = new Set<() => void>()
  const request = vi.fn(async (payload: PreparedAgentLaunchRequest['payload']) => {
    if (stalled) {
      return new Promise<never>(() => {})
    }
    if (payload.action === 'prepare') {
      return status(payload.operationId, generation)
    }
    if (payload.action === 'list' || payload.identity.daemonGeneration !== generation) {
      throw new Error('agent_session_ownership_unknown')
    }
    return status(payload.identity.operationId, generation)
  })
  const capability = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only these three adapter members.
  const adapter = {
    supportsPreparedAgentLaunches: capability,
    preparedAgentLaunch: request,
    onDaemonIdentityChanged: (listener: () => void) => {
      identityChanged.add(listener)
      return () => identityChanged.delete(listener)
    }
  } as unknown as DaemonPtyAdapter
  /** The same adapter reaches a replacement daemon, which reports a new identity. */
  const replace = (next: string) => {
    generation = next
    identityChanged.forEach((listener) => listener())
  }
  return { adapter, request, capability, replace }
}

/** Counts how often routing builds the adapter list, the work a warm request must never do. */
function adapterList(adapters: readonly DaemonPtyAdapter[]) {
  const list = vi.fn(() => adapters)
  return list
}

function prepare(operationId: string) {
  return {
    action: 'prepare' as const,
    operationId,
    fingerprint: 'fingerprint',
    claim,
    surface
  }
}

function status(operationId: string, daemonGeneration: string) {
  return {
    operationId,
    fingerprint: 'fingerprint',
    daemonGeneration,
    reservationGeneration: 'reservation',
    claim,
    surface,
    accepted: true,
    execution: 'not-dispatched',
    retirement: 'retained-pending',
    published: false
  }
}

function identity(operationId: string, daemonGeneration: string) {
  return { operationId, fingerprint: 'fingerprint', daemonGeneration, reservationGeneration: 'r' }
}

describe('prepared launch routing', () => {
  it.each([1, 10])(
    'sends %i observations of a prepared launch only to its owner, never to a stalled unrelated daemon',
    async (count) => {
      const owner = daemon('owner')
      const unrelated = daemon('unrelated', true)
      const routes = new PreparedAgentLaunchRoutes()
      const adapters = adapterList([unrelated.adapter, owner.adapter])
      await routes.request(owner.adapter, adapters, false, prepare('op'))
      for (let index = 0; index < count; index++) {
        await routes.request(owner.adapter, adapters, false, {
          action: 'wait',
          identity: identity('op', 'owner'),
          timeoutMs: 10_000
        })
      }
      expect(owner.request).toHaveBeenCalledTimes(1 + count)
      expect(unrelated.request).not.toHaveBeenCalled()
    }
  )

  it.each([1, 10])(
    'rejoins %i saved launches with one shared discovery per daemon generation',
    async (count) => {
      const owner = daemon('owner')
      const others = Array.from({ length: 3 }, (_, index) => daemon(`other-${index}`))
      const adapters = adapterList([...others.map((other) => other.adapter), owner.adapter])
      // A restarted main knows only the saved generation, not which adapter holds it.
      const routes = new PreparedAgentLaunchRoutes()
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          routes.request(owner.adapter, adapters, false, {
            action: 'status',
            identity: identity(`op-${index}`, 'owner')
          })
        )
      )
      for (const other of others) {
        expect(other.request).toHaveBeenCalledTimes(1)
      }
      expect(owner.request).toHaveBeenCalledTimes(1 + count)
    }
  )

  it.each([5, 50])(
    'serves warm observations with %i retained adapters without listing or filtering them',
    async (count) => {
      const owner = daemon('owner')
      const others = Array.from({ length: count - 1 }, (_, index) => daemon(`other-${index}`))
      const adapters = adapterList([...others.map((other) => other.adapter), owner.adapter])
      const routes = new PreparedAgentLaunchRoutes()
      await routes.request(owner.adapter, adapters, false, prepare('op'))
      for (let index = 0; index < 10; index++) {
        await routes.request(owner.adapter, adapters, false, {
          action: 'status',
          identity: identity('op', 'owner')
        })
      }
      // Owner work is one RPC per observation; nothing scales with the retained adapters.
      expect(owner.request).toHaveBeenCalledTimes(11)
      expect(adapters).not.toHaveBeenCalled()
      expect(owner.capability).not.toHaveBeenCalled()
      for (const other of others) {
        expect(other.capability).not.toHaveBeenCalled()
        expect(other.request).not.toHaveBeenCalled()
      }
    }
  )

  it.each([10, 100])(
    'keeps one route per addressable generation across %i daemon replacements on one adapter',
    async (count) => {
      const owner = daemon('generation-0')
      const adapters = adapterList([owner.adapter])
      const routes = new PreparedAgentLaunchRoutes()
      for (let index = 0; index < count; index++) {
        await routes.request(owner.adapter, adapters, false, prepare(`op-${index}`))
        owner.replace(`generation-${index + 1}`)
      }
      await routes.request(owner.adapter, adapters, false, prepare('current'))
      expect(routes['routes'].size).toBe(1)
      // The live generation still routes warm, with no discovery.
      await routes.request(owner.adapter, adapters, false, {
        action: 'status',
        identity: identity('current', `generation-${count}`)
      })
      expect(adapters).not.toHaveBeenCalled()
    }
  )

  it('keeps a shared generation routed when one of its operations retires, and drops it with its adapter', async () => {
    const owner = daemon('owner')
    const adapters = adapterList([owner.adapter])
    const routes = new PreparedAgentLaunchRoutes()
    await routes.request(owner.adapter, adapters, false, prepare('first'))
    await routes.request(owner.adapter, adapters, false, prepare('second'))
    await routes.request(owner.adapter, adapters, false, {
      action: 'retireInput',
      identity: identity('first', 'owner')
    })
    await routes.request(owner.adapter, adapters, false, {
      action: 'status',
      identity: identity('second', 'owner')
    })
    expect(adapters).not.toHaveBeenCalled()

    routes.forgetAdapter(owner.adapter)
    expect(routes['routes'].size).toBe(0)
  })

  it('never lets a discovery begun before a replacement reinstall the replaced route', async () => {
    const owner = daemon('old')
    const reply = Promise.withResolvers<void>()
    const respond = owner.request.getMockImplementation()!
    owner.request.mockImplementationOnce(async (payload) => {
      await reply.promise
      return respond(payload)
    })
    const routes = new PreparedAgentLaunchRoutes()
    const discovering = routes.request(owner.adapter, adapterList([owner.adapter]), false, {
      action: 'status',
      identity: identity('op', 'old')
    })
    routes.forgetAdapter(owner.adapter)
    reply.resolve()
    // The probe that began before the adapter was forgotten still answers its caller once.
    await discovering
    expect(routes['routes'].size).toBe(0)
  })
})
