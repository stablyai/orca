import { describe, expect, it } from 'vitest'

import type { AgentStatusOrchestrationContext } from '../../../../../../../shared/agent-status/contracts/agent-status-types'

import { AgentHookServer } from '../../../../../../agent-hooks/server/agent-hook-server'

import type { OrcaRuntimeService } from '../../../../../orca-runtime'

import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'

import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from '../../../../../terminal/output/terminal-orchestration-authority'

import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../../../../../terminal/identity/agent-status-observed-pane-identity'

import { projectFleetWorkerPage } from './worker-observation'

/** Capture hook identity at ingest; reminting cached observations during fleet reads could falsely match a new occupant's incarnation. Replay one row across rebind to catch that drift. */
const PANE_KEY = 'tab-observed:11111111-1111-4111-8111-111111111111'
const TERMINAL_HANDLE = 'term_observed'
const INCARNATION_ONE = 'pty-observed:inc-1'
const INCARNATION_TWO = 'pty-observed:inc-2'
const DISPATCH_OLD = 'disp-observed-old'
const DISPATCH_NEW = 'disp-observed-new'

type ObservedWorld = {
  bindPane: (paneKey: string, handle: string) => void
  runProcess: (handle: string, incarnation: string) => void
  dispatchPane: (paneKey: string, dispatchId: string | null) => void
  ingest: (paneKey: string, state: 'working' | 'waiting') => void
  runtime: OrcaRuntimeService
}

/** Real hook server, real ingest-time capture, real fleet snapshot accessor. */
function createWorld(): ObservedWorld {
  const handleByPane = new Map<string, string>()
  const incarnationByHandle = new Map<string, string>()
  const dispatchByPane = new Map<string, string>()
  const identity = {
    getAgentStatusTerminalHandleForPaneKey: (paneKey: string) => handleByPane.get(paneKey),
    getTerminalProcessIncarnation: (handle: string) => incarnationByHandle.get(handle) ?? null,
    getAgentStatusOrchestrationContextForPaneKey: (paneKey: string) => {
      const dispatchId = dispatchByPane.get(paneKey)
      return dispatchId ? ({ dispatchId } as AgentStatusOrchestrationContext) : undefined
    }
  }
  const server = new AgentHookServer()
  const observed = new AgentStatusObservedPaneIdentities()
  server.subscribeEnrichedStatus((entry) =>
    recordObservedAgentStatusPaneIdentity(observed, entry, identity)
  )
  const host = {
    ...identity,
    getAgentStatusSnapshotFn: () => server.getStatusSnapshot(),
    readObservedAgentStatusPaneIdentityFn: (paneKey: string) => observed.read(paneKey)
  }
  return {
    bindPane: (paneKey, handle) => handleByPane.set(paneKey, handle),
    runProcess: (handle, incarnation) => incarnationByHandle.set(handle, incarnation),
    dispatchPane: (paneKey, dispatchId) => {
      if (dispatchId === null) {
        dispatchByPane.delete(paneKey)
        return
      }
      dispatchByPane.set(paneKey, dispatchId)
    },
    ingest: (paneKey, state) =>
      server.ingestTerminalStatus({
        paneKey,
        connectionId: null,
        payload: { state, prompt: `turn ${state}`, agentType: 'claude' }
      }),
    runtime: {
      getOrchestrationFleetAgentStatusSnapshot: () =>
        OrcaRuntimeWithGetOrchestrationDispatchAuthority.prototype.getOrchestrationFleetAgentStatusSnapshot.call(
          host as never
        )
    } as unknown as OrcaRuntimeService
  }
}

function createDb(worker: {
  dispatchId: string
  paneKey: string | null
  handle: string | null
  incarnation: string | null
}): OrchestrationDb {
  return {
    listWorkerTerminalResources: () => [
      {
        dispatchId: worker.dispatchId,
        taskId: 'task-observed',
        runId: 'run-observed',
        parentTaskId: 'task-parent',
        workerState: 'ready',
        dispatchStatus: 'dispatched',
        workerStage: 'input_accepted',
        agentTerminalHandle: worker.handle,
        paneKey: worker.paneKey,
        worktreeId: 'wt-observed',
        terminalState: 'active',
        pendingInput: false,
        pendingApproval: false,
        terminationReason: null,
        resource:
          worker.incarnation === null
            ? null
            : {
                id: 'res-observed',
                owner_dispatch_id: worker.dispatchId,
                worktree_id: 'wt-observed',
                pane_key: worker.paneKey,
                process_incarnation: worker.incarnation,
                endpoint_id: null,
                endpoint_incarnation: null,
                host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
                ownership_state: 'owned',
                release_state: 'none',
                updated_at: new Date().toISOString()
              },
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        databaseId: 1
      }
    ],
    getWorkerAttentionFactsForDispatches: () => new Map()
  } as unknown as OrchestrationDb
}

function livenessOf(world: ObservedWorld, db: OrchestrationDb, dispatchId: string): unknown {
  return projectFleetWorkerPage(world.runtime, db, dispatchId)?.workers[0]?.liveness
}

describe('fleet evidence keeps the identity it was observed under', () => {
  it('refuses the same row once the durable resource advances to the new incarnation', () => {
    const world = createWorld()
    world.bindPane(PANE_KEY, TERMINAL_HANDLE)
    world.runProcess(TERMINAL_HANDLE, INCARNATION_ONE)
    world.dispatchPane(PANE_KEY, DISPATCH_OLD)
    world.ingest(PANE_KEY, 'working')
    // A new process owns both pane and durable worker; never retag the dead process's cached observation to match it.
    world.runProcess(TERMINAL_HANDLE, INCARNATION_TWO)

    expect(
      livenessOf(
        world,
        createDb({
          dispatchId: DISPATCH_OLD,
          paneKey: PANE_KEY,
          handle: TERMINAL_HANDLE,
          incarnation: INCARNATION_TWO
        }),
        DISPATCH_OLD
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'missing_status' })
  })

  it('refuses the same row for a dispatch that took the pane over afterwards', () => {
    const world = createWorld()
    world.bindPane(PANE_KEY, TERMINAL_HANDLE)
    world.runProcess(TERMINAL_HANDLE, INCARNATION_ONE)
    world.dispatchPane(PANE_KEY, DISPATCH_OLD)
    world.ingest(PANE_KEY, 'working')
    world.dispatchPane(PANE_KEY, DISPATCH_NEW)

    expect(
      livenessOf(
        world,
        createDb({
          dispatchId: DISPATCH_NEW,
          paneKey: PANE_KEY,
          handle: TERMINAL_HANDLE,
          incarnation: INCARNATION_ONE
        }),
        DISPATCH_NEW
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'missing_status' })
  })

  it('refuses the same row after a remint when no resource names an incarnation', () => {
    const world = createWorld()
    world.bindPane(PANE_KEY, TERMINAL_HANDLE)
    world.runProcess(TERMINAL_HANDLE, INCARNATION_ONE)
    world.dispatchPane(PANE_KEY, DISPATCH_OLD)
    world.ingest(PANE_KEY, 'working')
    world.runProcess(TERMINAL_HANDLE, INCARNATION_TWO)

    // Unsupervised workers lack durable resources to contradict a wrongly minted incarnation.
    expect(
      livenessOf(
        world,
        createDb({
          dispatchId: DISPATCH_OLD,
          paneKey: PANE_KEY,
          handle: TERMINAL_HANDLE,
          incarnation: null
        }),
        DISPATCH_OLD
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'missing_status' })
  })

  it('reads live for the rebound worker and not for the one it replaced', () => {
    const world = createWorld()
    world.bindPane(PANE_KEY, TERMINAL_HANDLE)
    world.runProcess(TERMINAL_HANDLE, INCARNATION_ONE)
    world.dispatchPane(PANE_KEY, DISPATCH_OLD)
    world.ingest(PANE_KEY, 'working')
    world.runProcess(TERMINAL_HANDLE, INCARNATION_TWO)
    world.dispatchPane(PANE_KEY, DISPATCH_NEW)
    world.ingest(PANE_KEY, 'waiting')

    expect(
      livenessOf(
        world,
        createDb({
          dispatchId: DISPATCH_NEW,
          paneKey: PANE_KEY,
          handle: TERMINAL_HANDLE,
          incarnation: INCARNATION_TWO
        }),
        DISPATCH_NEW
      )
    ).toMatchObject({ verdict: 'live', source: 'agent_status' })
    expect(
      livenessOf(
        world,
        createDb({
          dispatchId: DISPATCH_OLD,
          paneKey: PANE_KEY,
          handle: TERMINAL_HANDLE,
          incarnation: INCARNATION_ONE
        }),
        DISPATCH_OLD
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'missing_status' })
  })
})
