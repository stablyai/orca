// P1-4: a peer that predates the launch-token echo (pre-v34 daemon, old SSH
// relay) accepts `launchToken` on create and silently drops it, so its re-list
// can NEVER carry one. Reading that missing echo as absence settled spawn_failed
// for a launch the peer was still running, and the user's Retry then spawned a
// DUPLICATE agent beside it. The runtime must therefore AND its re-list
// authority with the provider's token-echo authority.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getHostAgentLaunchOperationStore } from '../agent-launch/agent-launch-operation-store-host'
import { retryRecoveryGateForFailureCode } from '../agent-launch/agent-launch-reconciliation'
import type { PendingAgentLaunchSnapshot } from '../agent-launch/agent-launch-operation-store'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { IPtyProvider } from '../providers/types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'r1::/wt-a'
const CONNECTION_ID = 'host-a'
const LIVE_SESSION_ID = `ssh:${CONNECTION_ID}@@pty-1`

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
      executionHostId: `ssh:${CONNECTION_ID}`
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
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId: string | null,
    deadline?: number,
    connectionId?: string | null
  ) => Promise<unknown>
}

/** A relay re-list that returns `sessions`, fronted by an SSH provider that does
 *  or does not echo launch tokens back in its listings. */
function makeRuntime(args: { echoesLaunchTokens: boolean; sessions: unknown[] }): {
  internals: Internals
  metaWrites: Record<string, unknown>[]
} {
  const provider = {
    providesLaunchTokenListings: () => args.echoesLaunchTokens
  } as unknown as IPtyProvider
  const runtime = new OrcaRuntimeService(null, undefined, {
    getSshProvider: () => provider
  })
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
  runtime.setPtyController({
    listProcesses: async () => args.sessions,
    hasPty: () => false,
    getForegroundProcess: async () => null
  } as never)
  return { internals, metaWrites }
}

/** One live session the peer lists WITHOUT a launchToken (it dropped the one it
 *  was handed) — the surviving agent the pending launch belongs to. */
function tokenlessLiveSession(worktreeId: string | null): Record<string, unknown> {
  return {
    id: LIVE_SESSION_ID,
    cwd: '/remote/wt-a',
    title: 'claude',
    ...(worktreeId ? { worktreeId } : {})
  }
}

afterEach(() => {
  // The host operation store is a singleton; leave nothing behind for other suites.
  getHostAgentLaunchOperationStore().rebuildPendingFrom([])
  getHostAgentLaunchOperationStore().rebuildSettledFrom([])
})

describe('launch-token echo authority in reconcile', () => {
  it('holds the launch pending when the host cannot echo tokens (no duplicate on Retry)', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-legacy')])
    const { internals, metaWrites } = makeRuntime({
      echoesLaunchTokens: false,
      sessions: [tokenlessLiveSession(WORKTREE_ID)]
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      CONNECTION_ID
    )

    // Never settled: the reservation and private snapshot survive for a real proof.
    expect(opStore.getPending('tok-legacy')).not.toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-legacy')).toBeNull()
    const failure = metaWrites.at(-1)?.agentLaunchFailure as { code?: string } | undefined
    expect(failure?.code).toBe('launch_state_unknown')
    // The Retry that duplicated the live agent is gated behind an explicit Forget.
    expect(retryRecoveryGateForFailureCode('launch_state_unknown')).toEqual({
      kind: 'launch_state_unknown'
    })
  })

  it('settles absent on the same re-list when the host DOES echo tokens', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-v34')])
    const { internals } = makeRuntime({
      echoesLaunchTokens: true,
      sessions: [tokenlessLiveSession(WORKTREE_ID)]
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      CONNECTION_ID
    )

    // A v34 peer lists every token it holds, so a missing echo IS absence proof.
    expect(opStore.getPending('tok-v34')).toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-v34')).toMatchObject({
      status: 'failed'
    })
  })

  it('still settles a non-echoing host absent when nothing live remains in the worktree', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-gone')])
    const { internals } = makeRuntime({ echoesLaunchTokens: false, sessions: [] })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      CONNECTION_ID
    )

    // Pre-token identification still proves absence, so recovery is not stranded.
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-gone')).toMatchObject({
      status: 'failed'
    })
  })

  it('holds the launch when a non-echoing host lists a session it cannot attribute', async () => {
    const opStore = getHostAgentLaunchOperationStore()
    opStore.rebuildPendingFrom([pending('tok-unattributed')])
    const { internals } = makeRuntime({
      echoesLaunchTokens: false,
      sessions: [tokenlessLiveSession(null)]
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      CONNECTION_ID
    )

    // The session never enters ptysById and carries no token: it may BE this launch.
    expect(opStore.getPending('tok-unattributed')).not.toBeNull()
    expect(opStore.findSettledByIdempotencyKey(WORKTREE_ID, 'key-tok-unattributed')).toBeNull()
  })
})
