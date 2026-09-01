// Runtime composition of the launch reconciler's liveness inputs:
//   • L2-#6 — a re-listed session whose worktree could not be inferred never
//     enters ptysById, but its launch token was seen live in the same pass; the
//     token match must settle the pending launched, never absent/spawn_failed.
//   • L4-M2 — a token whose spawn is running in THIS process right now
//     (beginPending → settle window) must be skipped by every reconcile pass,
//     or a list RPC racing the spawn false-settles spawn_failed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getHostAgentLaunchOperationStore } from '../agent-launch/agent-launch-operation-store-host'
import type { PendingAgentLaunchSnapshot } from '../agent-launch/agent-launch-operation-store'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'r1::/wt-a'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: true,
      executionHostId: 'ssh:host-a'
    }
  }
}

function pending(token: string): PendingAgentLaunchSnapshot {
  return {
    operationId: `op-${token}`,
    idempotencyKey: `key-${token}`,
    scope: WORKTREE_ID,
    clientMutationId: null,
    payloadDigest: 'digest-1',
    launchToken: token,
    intent: 'interactive',
    principal: { kind: 'local' },
    snapshot: snapshot()
  }
}

type Internals = {
  store: unknown
  reconcilePendingAgentLaunches: (
    isHostAuthoritative: (hostId: string) => boolean,
    filter?: (pending: PendingAgentLaunchSnapshot) => boolean,
    relistedTokenPtyIds?: ReadonlyMap<string, string>
  ) => void
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId: string | null,
    deadline?: number,
    connectionId?: string | null
  ) => Promise<unknown>
}

function makeRuntime(): {
  runtime: OrcaRuntimeService
  internals: Internals
  metaWrites: Record<string, unknown>[]
} {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as Internals
  const metaWrites: Record<string, unknown>[] = []
  internals.store = {
    getWorktreeMeta: () => ({}),
    setWorkspaceSession: () => {},
    setWorktreeMeta: (_id: string, meta: Record<string, unknown>) => {
      metaWrites.push(meta)
      return meta
    },
    getSettings: () => ({})
  }
  return { runtime, internals, metaWrites }
}

afterEach(() => {
  // The host operation store is a singleton; leave nothing behind for other suites.
  getHostAgentLaunchOperationStore().rebuildPendingFrom([])
  getHostAgentLaunchOperationStore().rebuildSettledFrom([])
})

describe('reconcilePendingAgentLaunches liveness composition', () => {
  it('settles a re-listed token with unresolvable worktree as launched, never spawn_failed (L2-#6)', () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-relist')])
    const { internals, metaWrites } = makeRuntime()

    internals.reconcilePendingAgentLaunches(
      () => true,
      undefined,
      new Map([['tok-relist', 'ssh-pty-9']])
    )

    // Settled launched: pending cleared, NO durable failure card written.
    expect(opStore.getPending('tok-relist')).toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-relist')).toMatchObject({
      status: 'launched',
      terminalId: 'ssh-pty-9'
    })
    expect(metaWrites).toEqual([{ pendingAgentLaunch: undefined }])
  })

  it('without the re-list token index the same pending would false-settle spawn_failed', () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-relist')])
    const { internals, metaWrites } = makeRuntime()

    internals.reconcilePendingAgentLaunches(() => true)

    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-relist')).toMatchObject({
      status: 'failed'
    })
    expect(metaWrites[0]).toMatchObject({
      agentLaunchFailure: expect.objectContaining({ code: 'spawn_failed' })
    })
  })

  it('skips a token whose spawn is in flight in this process (L4-M2)', () => {
    const opStore = getHostAgentLaunchOperationStore()
    // beginPending is what the transaction runs right before spawning; it marks
    // the token in-flight until settle.
    opStore.beginPending(pending('tok-spawning'))
    const { internals, metaWrites } = makeRuntime()

    internals.reconcilePendingAgentLaunches(() => true)

    // Untouched: no settle, no failure card, pending survives for the spawn.
    expect(opStore.getPending('tok-spawning')).not.toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-spawning')).toBeNull()
    expect(metaWrites).toEqual([])

    // Once the spawn settles (clearPending), reconcile may speak again.
    opStore.clearPending('tok-spawning')
    expect(opStore.isSpawnInFlight('tok-spawning')).toBe(false)
  })
})

// A scoped SSH re-list that SUCCEEDS speaks for its own connection even when it
// returns zero sessions. Deriving the authoritative scope from the response rows
// instead left such a host "unknown" forever: its pending held capacity and could
// never be retried.
describe('scoped SSH re-list authority', () => {
  function makeSshRuntime(listProcesses: () => Promise<unknown[]>) {
    const made = makeRuntime()
    made.runtime.setPtyController({
      listProcesses,
      hasPty: () => false
    } as never)
    return made
  }

  it('settles a pending on a successful but empty scoped re-list', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-ssh-empty')])
    const { internals } = makeSshRuntime(async () => [])

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, 'host-a')

    expect(opStore.getPending('tok-ssh-empty')).toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-ssh-empty')).toMatchObject({
      status: 'failed'
    })
  })

  it('leaves the pending untouched when the scoped re-list fails', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-ssh-failed')])
    const { internals, metaWrites } = makeSshRuntime(async () => {
      throw new Error('relay down')
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, 'host-a')

    // "Re-list failed" is not evidence of absence: retryable, still holding its slot.
    expect(opStore.getPending('tok-ssh-failed')).not.toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-ssh-failed')).toBeNull()
    expect(metaWrites).toEqual([])
  })

  it('does not let one connection speak for another SSH host', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-other-host')])
    const { internals } = makeSshRuntime(async () => [])

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, 'host-b')

    // The pending targets ssh:host-a; host-b's empty list says nothing about it.
    expect(opStore.getPending('tok-other-host')).not.toBeNull()
  })
})
