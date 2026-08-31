import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  resolveStructuredSessionRecovery,
  type StructuredSessionRecoveryResolutionDeps
} from './structured-agent-session-recovery-resolution'

const NOW = 1_800_000_000_000
const SESSION = 'session-recovery'
const roots: string[] = []
let operations = 0

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function openStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-resolution-'))
  roots.push(root)
  return AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
}

async function reserve(store: AgentSessionRecordStore, runtimeKind: 'native' | 'tui' = 'native') {
  operations += 1
  return store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
    runtimeKind,
    expectedFence: null,
    spawnToken: 'spawn-recovery',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-${String(operations).padStart(32, '0')}`,
      fingerprint: 'create'
    },
    now: NOW
  })
}

async function liveOwner(store: AgentSessionRecordStore, runtimeKind: 'native' | 'tui' = 'native') {
  const reserved = await reserve(store, runtimeKind)
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-recovery'
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-recovery',
      handle: { provider: 'codex', threadId: 'thread-recovery' },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
}

async function latch(store: AgentSessionRecordStore, stage: 'recovering' | 'manual-recovery') {
  return store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, handoffStage: stage }
  }))
}

function deps(
  store: AgentSessionRecordStore,
  probe: (calls: number) => AgentSessionOwnerProbe,
  overrides: Partial<StructuredSessionRecoveryResolutionDeps> = {}
): StructuredSessionRecoveryResolutionDeps & { probes: () => number } {
  let calls = 0
  return {
    store,
    probeRecord: async () => {
      calls += 1
      return probe(calls)
    },
    now: () => NOW + 10_000,
    delay: async () => {},
    probes: () => calls,
    ...overrides
  }
}

describe('structured session recovery resolution', () => {
  it('does not release an ownerless native reservation without processless proof', async () => {
    const store = await openStore()
    await reserve(store)
    await latch(store, 'recovering')

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'indeterminate', reason: 'no scan' })),
      SESSION
    )

    expect(result).toBe('unresolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'recovering',
      runtimeFence: 1,
      reservedSpawnToken: 'spawn-recovery'
    })
  })

  it('evicts a latched owner the probe now proves dead, without a stop request', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store, 'manual-recovery')
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'pid-absent' }), { stopOwnerProcess }),
      SESSION
    )

    expect(result).toBe('resolved')
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2,
      ownerProcess: null
    })
  })

  it('stops a live identity-matched orphan and evicts only after absence is proven', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store, 'recovering')
    let alive = true
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })

    const result = await resolveStructuredSessionRecovery(
      deps(
        store,
        () =>
          alive
            ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
            : { outcome: 'pid-absent' },
        { stopOwnerProcess }
      ),
      SESSION
    )

    expect(result).toBe('resolved')
    expect(stopOwnerProcess).toHaveBeenCalledTimes(1)
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2
    })
  })

  it('escalates the stop request but never evicts an owner that stays alive', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store, 'recovering')
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }), {
        stopOwnerProcess
      }),
      SESSION
    )

    expect(result).toBe('unresolved')
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGKILL')
    // The latch is preserved verbatim: no fence move, no cleared owner, no lost state.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: 'recovering',
      runtimeFence: 1,
      ownerProcess: { pid: 4242 }
    })
  })

  it('leaves an unverifiable owner latched and requests no stop', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store, 'recovering')
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'indeterminate', reason: 'probe timed out' }), {
        stopOwnerProcess
      }),
      SESSION
    )

    expect(result).toBe('unresolved')
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: 'recovering',
      runtimeFence: 1
    })
  })

  it('leaves a TUI record that still names an owner to its own recovery transport', async () => {
    const store = await openStore()
    await liveOwner(store, 'tui')
    await latch(store, 'recovering')

    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => ({ outcome: 'pid-absent' })),
        SESSION
      )
    ).toBe('not-applicable')
    expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')
  })

  it('resolves a TUI reservation that names nobody, because nothing else can', async () => {
    // The TUI carve-out exists because a TUI owner has its own recovery transport, and that
    // transport needs a process to talk to. A reservation that crashed before `commitProcessIdentity`
    // names none, so skipping it here left the session with no exit at all.
    const store = await openStore()
    await reserve(store, 'tui')
    await latch(store, 'recovering')

    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => ({ outcome: 'reservation-unused' })),
        SESSION
      )
    ).toBe('resolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'released'
    })
  })

  it('frees a conflicted claim once its named owner is proven gone', async () => {
    const store = await openStore()
    await liveOwner(store)
    await store.markClaimConflicted(SESSION, NOW)

    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => ({ outcome: 'pid-absent' })),
        SESSION
      )
    ).toBe('resolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'released',
      deathEvidence: { kind: 'pid-absent' }
    })
  })

  it('never stops the process a conflicted claim names, and keeps the conflict without proof', async () => {
    const store = await openStore()
    await liveOwner(store)
    await store.markClaimConflicted(SESSION, NOW)
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] }), {
        stopOwnerProcess
      }),
      SESSION
    )

    // Ownership was never settled, so the process on the other side of the conflict is not
    // Orca's to kill; only the user can decide which claimant wins.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(result).toBe('unresolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'manual-recovery'
    })
  })
})
