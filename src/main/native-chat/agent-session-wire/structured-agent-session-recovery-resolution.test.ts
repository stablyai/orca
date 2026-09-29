import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  readPersistedLease,
  writeOlderBuildLease
} from '../../runtime/agent-session-older-build-lease.test-fixture'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { supervisedPosixLaunch } from '../../codex/codex-app-server-posix-supervisor'
import {
  resolveStructuredSessionRecovery,
  type StructuredSessionRecoveryResolutionDeps
} from './structured-agent-session-recovery-resolution'

const NOW = 1_800_000_000_000
const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
const SESSION = 'session-recovery'
const roots: string[] = []
let operations = 0

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function newStoreDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-resolution-'))
  roots.push(root)
  return root
}

async function openStore(directory?: string): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({
    directory: directory ?? (await newStoreDirectory()),
    hostId: 'local'
  })
}

async function reserve(store: AgentSessionRecordStore) {
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

async function liveOwner(store: AgentSessionRecordStore, pid = 4242) {
  const reserved = await reserve(store)
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid,
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

async function latch(store: AgentSessionRecordStore) {
  return store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, handoffStage: 'recovering' }
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
  it('releases an ownerless reservation: nothing it recorded can be holding it', async () => {
    const store = await openStore()
    await reserve(store)
    await latch(store)

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'indeterminate', reason: 'no scan' })),
      SESSION
    )

    expect(result).toBe('resolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2,
      reservedSpawnToken: null,
      deathEvidence: null
    })
  })

  it('evicts a latched owner the probe now proves dead, without a stop request', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store)
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
    await latch(store)
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

  it('releases an owner that survives the stop ladder, with no death evidence', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store)
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }), {
        stopOwnerProcess
      }),
      SESSION
    )

    expect(result).toBe('resolved')
    expect(stopOwnerProcess.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL']
    ])
    // Its transport died with the runtime that held it; nothing proved it gone, so no evidence.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2,
      ownerProcess: null,
      deathEvidence: null
    })
  })

  it('releases an owner whose identity cannot be verified, and signals nothing', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store)
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'indeterminate', reason: 'probe timed out' }), {
        stopOwnerProcess
      }),
      SESSION
    )

    expect(result).toBe('resolved')
    // The pid may have been reused by an unrelated process.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2,
      ownerProcess: null,
      deathEvidence: null
    })
  })

  it('waits out a terminal owner an older build recorded, and never stops it', async () => {
    const directory = await newStoreDirectory()
    await liveOwner(await openStore(directory))
    await writeOlderBuildLease(directory, SESSION, { runtimeKind: 'tui' })
    await (await openStore(directory)).reconcileOnRestart({ probe: async () => MATCHED, now: NOW })
    // A fresh load of what that restart persisted, as any later or older build reads it.
    const store = await openStore(directory)
    await store.reconcileOnRestart({ probe: async () => MATCHED, now: NOW })
    const stopOwnerProcess = vi.fn()

    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => MATCHED, { stopOwnerProcess }),
        SESSION
      )
    ).toBe('unresolved')
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    // Older builds stop only a native owner that is not conflicted, the same rule as this one.
    expect(await readPersistedLease(directory, SESSION)).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'conflicted',
      handoffStage: 'recovering'
    })

    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => ({ outcome: 'pid-absent' })),
        SESSION
      )
    ).toBe('resolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'released'
    })
  })

  it('releases a terminal reservation an older build left naming nobody at restart', async () => {
    const directory = await newStoreDirectory()
    await reserve(await openStore(directory))
    await writeOlderBuildLease(directory, SESSION, { runtimeKind: 'tui' })
    const store = await openStore(directory)
    await store.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no scan' }),
      now: NOW
    })
    // No process is recorded for a conflict to name, so there is nothing to wait out.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: null
    })
    expect(
      await resolveStructuredSessionRecovery(
        deps(store, () => ({ outcome: 'reservation-unused' })),
        SESSION
      )
    ).toBe('not-applicable')
  })
})

describe.runIf(process.platform !== 'win32')(
  'structured session recovery of a supervised owner',
  () => {
    const recordedPids: number[] = []
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      }
    }

    afterEach(() => {
      for (const pid of recordedPids.splice(0)) {
        if (alive(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      }
    })

    it('evicts only after the supervisor has reaped a provider that ignores SIGTERM', async () => {
      const launch = supervisedPosixLaunch(
        {
          command: process.execPath,
          args: [
            '-e',
            "process.on('SIGTERM', () => {}); process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 60000)"
          ]
        },
        process.env
      )
      const supervisor = spawn(launch.command, launch.args, {
        env: launch.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true
      })
      recordedPids.push(supervisor.pid!)
      const provider = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('provider never started')), 10_000)
        supervisor.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timeout)
          resolve(Number(chunk.toString().trim()))
        })
      })
      recordedPids.push(provider)
      const store = await openStore()
      await liveOwner(store, supervisor.pid!)
      await latch(store)

      const result = await resolveStructuredSessionRecovery(
        {
          store,
          // The recorded pid is the supervisor's; its absence is the proof recovery evicts on.
          probeRecord: async () =>
            alive(supervisor.pid!) ? MATCHED : { outcome: 'pid-absent' as const },
          now: () => NOW + 10_000
        },
        SESSION
      )

      expect(result).toBe('resolved')
      // Evicted on proof of death, which must hold for the provider too, not only the supervisor.
      expect(store.getRecord(SESSION)?.lease.deathEvidence).not.toBeNull()
      expect(alive(provider)).toBe(false)
    })
  }
)
