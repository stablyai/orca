import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'

const NOW = 1_800_000_000_000
const roots: string[] = []

async function liveStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-lease-renewer-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
  const reserved = await store.reserveOwner({
    sessionId: 'session-renewal',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-renewal',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  await store.commitProcessIdentity({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-renewal'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    link: {
      linkId: 'link-renewal',
      handle: { provider: 'codex', threadId: 'thread-renewal' },
      origin: 'created',
      mintedAtFence: reserved.record.lease.runtimeFence,
      observedAt: NOW
    },
    now: NOW
  })
  return store
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured agent-session lease renewal', () => {
  it('drives renewal on the production interval', async () => {
    vi.useFakeTimers()
    const store = await liveStore()
    let now = NOW
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      }),
      now: () => now
    })
    try {
      renewer.start()
      now += 10_000
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() =>
        expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(now)
      )
    } finally {
      renewer.stop()
      vi.useRealTimers()
    }
  })

  it('renews every live owner only after re-proving its child identity', async () => {
    const store = await liveStore()
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const onRenewed = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe,
      now: () => NOW + 10_000,
      onRenewed
    })

    await renewer.renewNow()

    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
    expect(onRenewed).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-renewal' })
    )
  })

  it('stops extending the lease when child proof is no longer sufficient', async () => {
    const store = await liveStore()
    const onError = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'probe unavailable' }),
      now: () => NOW + 10_000,
      onError
    })

    await renewer.renewNow()

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(onError).toHaveBeenCalledWith({
      sessionId: 'session-renewal',
      error: expect.any(Error)
    })
  })

  it('routes a proven dead TUI owner into handoff recovery', async () => {
    const store = await liveStore()
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      lease: { ...record.lease, runtimeKind: 'tui' }
    }))
    const onDeadTuiOwner = vi.fn(async () => undefined)
    const onError = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW + 10_000,
      onDeadTuiOwner,
      onError
    })

    await renewer.renewNow()

    expect(onDeadTuiOwner).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-renewal' }),
      { outcome: 'pid-absent' }
    )
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(onError).not.toHaveBeenCalled()
  })
})
