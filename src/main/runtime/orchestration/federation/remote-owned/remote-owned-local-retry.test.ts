import { afterEach, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import { peerCoordinatorCaller } from '../../addressing/orchestration-caller-identity'
import { startWorker } from '../../../rpc/methods/orchestration/worker/worker-start-method'
import {
  createWorkerReleaseFixture,
  isStartReceipt,
  type WorkerReleaseFixture
} from '../../../rpc/methods/orchestration/worker/release/worker-release.test-fixture'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import { remoteServerPin } from '../../db/remote-owned/remote-run-links'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import { startRemoteOwnedWorker } from './remote-owned-start'

afterEach(() => vi.restoreAllMocks())

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}

type PairedServer = {
  home: WorkerReleaseFixture
  server: WorkerReleaseFixture
  startOnServer: (params: Record<string, unknown>, requestId: string) => Promise<unknown>
  /** Stops the attempt on the server and imports what its queue sends home. */
  stopOnServer: (dispatchId: string) => void
  refuseNextStart: () => void
}

async function withPairedServer(test: (paired: PairedServer) => Promise<void>): Promise<void> {
  const home = createWorkerReleaseFixture()
  const server = createWorkerReleaseFixture()
  try {
    vi.spyOn(home.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(home.runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue(SERVER)
    let refuseNext = false
    vi.spyOn(home.runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_env, method, payload, _timeout, meta) => {
        if (method === 'status.get') {
          return {
            runtimeId: 'rt_server',
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
            ]
          }
        }
        if (refuseNext) {
          refuseNext = false
          throw new OrchestrationError('invalid_argument', 'Refused.', { effectsApplied: false })
        }
        const caller = peerCoordinatorCaller(
          server.db.admitPeerRun({
            peerFingerprint: 'fp_home',
            peerRun: meta!.orchestrationPeerRun!
          })
        )
        return startWorker(WorkerStartParams.parse({ ...Object(payload), from: caller.address }), {
          runtime: server.runtime,
          orchestrationCaller: caller
        })
      }
    )

    const startOnServer = (params: Record<string, unknown>, requestId: string) =>
      startRemoteOwnedWorker(
        home.runtime,
        WorkerStartParams.parse({
          from: 'term_coord',
          on: 'server',
          worktree: 'id:repo::worktree',
          ...params
        }),
        { runtime: home.runtime },
        requestId
      )

    const stopOnServer = (dispatchId: string) => {
      server.db.beginWorkerStop(dispatchId, 'epoch')
      server.db.settleWorkerStop(dispatchId)
      const conversationId = getRemoteDispatch(home.db, dispatchId)!.conversation_id
      for (const item of server.db.listPendingFederationRelay(conversationId, 'to_home')) {
        importRemoteOwnedItem(home.db, remoteServerPin(SERVER), {
          conversationId,
          sequence: item.sequence,
          messageId: item.message_id,
          kind: item.kind,
          payload: item.payload
        })
      }
    }

    await test({
      home,
      server,
      startOnServer,
      stopOnServer,
      refuseNextStart: () => {
        refuseNext = true
      }
    })
  } finally {
    home.db.close()
    server.db.close()
  }
}

async function withStoppedAttemptHere(
  test: (args: {
    home: WorkerReleaseFixture
    stopped: { taskId: string; dispatchId: string }
    retryOnServer: (requestId: string) => Promise<unknown>
    refuseNextStart: () => void
  }) => Promise<void>
): Promise<void> {
  await withPairedServer(async ({ home, startOnServer, refuseNextStart }) => {
    const stopped = await home.startWorker()
    home.db.beginWorkerStop(stopped.dispatchId, 'epoch')
    home.db.settleWorkerStop(stopped.dispatchId)
    expect(home.db.getTask(stopped.taskId)?.status).toBe('blocked')

    await test({
      home,
      stopped,
      retryOnServer: (requestId) =>
        startOnServer({ task: stopped.taskId, retryOf: stopped.dispatchId }, requestId),
      refuseNextStart
    })
  })
}

/** A Task started on the server whose attempt there was stopped. */
async function stoppedOnServer({
  startOnServer,
  stopOnServer
}: PairedServer): Promise<{ taskId: string; dispatchId: string }> {
  const started = await startOnServer({ spec: 'server first', agent: 'codex' }, 'req_s1')
  if (!isStartReceipt(started) || !('taskId' in started) || typeof started.taskId !== 'string') {
    throw new Error('expected a start receipt from the server')
  }
  stopOnServer(started.dispatchId)
  return { taskId: started.taskId, dispatchId: started.dispatchId }
}

function lastServerStartPayload(home: WorkerReleaseFixture): unknown {
  return vi
    .mocked(home.runtime.callOrchestrationWorkerServer)
    .mock.calls.findLast(([, method]) => method === 'orchestration.workerStart')?.[2]
}

it('retries a stopped attempt that ran here onto a server that owns its workers', async () => {
  await withStoppedAttemptHere(async ({ home, stopped, retryOnServer, refuseNextStart }) => {
    // A refusal there leaves the attempt here as the Task's latest, so it can be retried again.
    refuseNextStart()
    await expect(retryOnServer('req_refused')).rejects.toThrow('Refused.')
    expect(home.db.getTask(stopped.taskId)?.status).toBe('blocked')
    const retried = await retryOnServer('req_retry_on_server')

    expect(retried).toMatchObject({ state: 'ready', taskId: stopped.taskId })
    expect(retried).not.toHaveProperty('forQuestion')
    expect(home.db.getTask(stopped.taskId)?.status).toBe('dispatched')
  })
})

it("keeps a bot item's attempt on this computer instead of moving its retry to a server", async () => {
  await withStoppedAttemptHere(async ({ home, stopped, retryOnServer }) => {
    home.db.db
      .prepare('UPDATE dispatch_contexts SET origin_ref = ? WHERE id = ?')
      .run('item_1', stopped.dispatchId)

    await expect(retryOnServer('req_item')).rejects.toThrow("its retry can't use --on")
    expect(home.runtime.callOrchestrationWorkerServer).not.toHaveBeenCalled()
    expect(home.db.getTask(stopped.taskId)?.status).toBe('blocked')
  })
})

it('says the question the attempt here was for is not linked to its retry on a server', async () => {
  await withStoppedAttemptHere(async ({ home, stopped, retryOnServer }) => {
    home.db.db
      .prepare('UPDATE dispatch_contexts SET for_message_id = ? WHERE id = ?')
      .run('msg_question', stopped.dispatchId)

    expect(await retryOnServer('req_question')).toMatchObject({
      state: 'ready',
      forQuestion: {
        question: 'msg_question',
        linked: false,
        why: "a worker on a paired computer can't be linked to a question"
      }
    })
  })
})

it('retries an attempt on the server by naming it there, without a spec', async () => {
  await withPairedServer(async (paired) => {
    const s1 = await stoppedOnServer(paired)
    expect(paired.home.db.getTask(s1.taskId)?.status).toBe('blocked')

    const retried = await paired.startOnServer(
      { task: s1.taskId, retryOf: s1.dispatchId },
      'req_retry_s1'
    )

    const sent = lastServerStartPayload(paired.home)
    expect(sent).toMatchObject({ retryOf: s1.dispatchId, task: s1.taskId, adoptTaskId: s1.taskId })
    expect(sent).not.toHaveProperty('spec')
    expect(retried).toMatchObject({ state: 'ready', taskId: s1.taskId })
  })
})

it('moves a retry back to the server after a server attempt and a stopped retry here', async () => {
  await withPairedServer(async (paired) => {
    const { home, server } = paired
    const s1 = await stoppedOnServer(paired)
    const d2 = await home.call('orchestration.workerStart', {
      task: s1.taskId,
      from: 'term_coord',
      retryOf: s1.dispatchId
    })
    if (!isStartReceipt(d2)) {
      throw new Error('expected a start receipt here')
    }
    home.db.beginWorkerStop(d2.dispatchId, 'epoch')
    home.db.settleWorkerStop(d2.dispatchId)
    expect(home.db.getTask(s1.taskId)?.status).toBe('blocked')
    // The server still holds the adopted Task from its own stopped attempt.
    expect(server.db.getTask(s1.taskId)?.status).toBe('blocked')

    const retried = await paired.startOnServer(
      { task: s1.taskId, retryOf: d2.dispatchId },
      'req_retry_d2'
    )

    const sent = lastServerStartPayload(home)
    expect(sent).toMatchObject({ spec: 'server first', adoptTaskId: s1.taskId })
    expect(sent).not.toHaveProperty('retryOf')
    expect(retried).toMatchObject({ state: 'ready', taskId: s1.taskId })
    expect(home.db.getTask(s1.taskId)?.status).toBe('dispatched')
    expect(server.db.getDispatchContext(s1.taskId)?.id).not.toBe(s1.dispatchId)
  })
})
