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

function daemon(generation: string, stalled = false) {
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
  const adapter = {
    supportsPreparedAgentLaunches: () => true,
    preparedAgentLaunch: request
  } as unknown as DaemonPtyAdapter
  return { adapter, request }
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
      const adapters = [unrelated.adapter, owner.adapter]
      await routes.request(owner.adapter, adapters, false, {
        action: 'prepare',
        operationId: 'op',
        fingerprint: 'fingerprint',
        claim,
        surface
      })
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
      const adapters = [...others.map((other) => other.adapter), owner.adapter]
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
})
