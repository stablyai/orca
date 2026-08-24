import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import { syncFederatedDispatch } from './federation-sync'

// A worker server and its Run home are two machines with two clocks. Heartbeat freshness is only
// meaningful if it is measured entirely on the home clock, so these tests pin that: whatever the
// worker server sends, the age the coordinator reads is time since the home host imported it.
describe('federated heartbeat arrival clock', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  const ENVIRONMENT_ID = 'environment_windows'
  const PEER_FINGERPRINT = 'windows_peer_fingerprint'
  const DECADE_OLD_WORKER_CLOCK = '2014-01-01T00:00:00.000Z'

  function startFederatedLane(): { runtime: OrcaRuntimeService; dispatchId: string; runId: string } {
    const database = new OrchestrationDb(':memory:')
    db = database
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(database)
    const run = database.createRun({
      objective: 'federated freshness',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = database.createTask({ spec: 'remote lane', runId: run.id })
    const started = database.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { agent: 'codex' },
      federation: {
        environmentId: ENVIRONMENT_ID,
        environmentName: 'windows',
        peerFingerprint: PEER_FINGERPRINT,
        protocolVersion: 1
      }
    })
    database.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_windows_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: 'repo::windows-worktree',
      setupState: 'not_applicable',
      effects: []
    })
    database.markWorkerDispatchReady(started.dispatch.id)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: ENVIRONMENT_ID,
      name: 'windows',
      peerFingerprint: PEER_FINGERPRINT
    } as never)
    return { runtime, dispatchId: started.dispatch.id, runId: run.id }
  }

  // Shape captured from a real worker server's relay queue: a heartbeat relays the message body only.
  const heartbeatRelayPayload = JSON.stringify({
    from: 'term_windows_worker',
    subject: 'alive',
    body: 'still working',
    type: 'heartbeat',
    priority: 'normal',
    threadId: null
  })

  function answerAsWorkerServer(runtime: OrcaRuntimeService, payload: string): void {
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method, params) => {
        if (method === 'orchestration.federationPull') {
          return {
            runtimeEpoch: 'remote_epoch_1',
            items: [
              {
                dispatch_id: (params as { dispatchId: string }).dispatchId,
                sequence: 1,
                message_id: 'relay_heartbeat',
                kind: 'heartbeat',
                // The worker server's own bookkeeping is a decade behind this host.
                created_at: DECADE_OLD_WORKER_CLOCK,
                payload
              }
            ]
          } as never
        }
        return { acknowledgedThrough: 1 } as never
      }
    )
  }

  function readLane(runtime: OrcaRuntimeService, runId: string, dispatchId: string) {
    return runtime
      .getOrchestrationDb()
      .listWorkerTerminalResources({ runId })
      .find((row) => row.dispatchId === dispatchId)
  }

  it('ages a relayed heartbeat on the home clock even when the worker server is a decade behind', async () => {
    const { runtime, dispatchId, runId } = startFederatedLane()
    answerAsWorkerServer(runtime, heartbeatRelayPayload)
    expect(readLane(runtime, runId, dispatchId)).toMatchObject({ heartbeatState: 'never' })

    await syncFederatedDispatch(runtime, dispatchId)

    const lane = readLane(runtime, runId, dispatchId)
    expect(lane?.heartbeatState).toBe('recorded')
    expect(lane?.heartbeatAgeSeconds).toBeLessThan(60)
    expect(lane?.lastHeartbeatReceivedAt).not.toContain('2014')
  })

  it('carries no worker timestamp on the relayed heartbeat for the home to copy', () => {
    // The structural reason the skew above cannot leak: there is nothing time-shaped in the body, so
    // the Run home has no remote stamp available and must use its own clock.
    const relayed = JSON.parse(heartbeatRelayPayload) as Record<string, unknown>

    expect(relayed.type).toBe('heartbeat')
    expect(Object.keys(relayed).filter((key) => /at$|time|date/i.test(key))).toEqual([])
  })

  it('ignores a timestamp a worker server smuggles into the relayed body', async () => {
    const { runtime, dispatchId, runId } = startFederatedLane()
    answerAsWorkerServer(
      runtime,
      JSON.stringify({
        ...(JSON.parse(heartbeatRelayPayload) as Record<string, unknown>),
        created_at: DECADE_OLD_WORKER_CLOCK,
        at: DECADE_OLD_WORKER_CLOCK
      })
    )

    await syncFederatedDispatch(runtime, dispatchId)

    const lane = readLane(runtime, runId, dispatchId)
    expect(lane?.heartbeatState).toBe('recorded')
    expect(lane?.heartbeatAgeSeconds).toBeLessThan(60)
    expect(lane?.lastHeartbeatReceivedAt).not.toContain('2014')
  })
})
