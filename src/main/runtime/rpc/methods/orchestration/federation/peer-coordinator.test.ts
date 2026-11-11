import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { generateId } from '../../../../orchestration/db/generated-id'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcResponse } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'

const WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'
const PAIRED = {
  authenticatedCallerFingerprint: 'fingerprint_a',
  pairedDeviceId: 'device_a',
  clientKind: 'runtime' as const
}

describe('a paired Orca coordinating its Run on this server', () => {
  let dir: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let conversationId: string
  let sequence = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-coordinator-'))
    db = new OrchestrationDb(join(dir, 'b.db'))
    runtime = new OrcaRuntimeService(null)
    const panes: Record<string, string> = {
      term_w: WORKER_PANE
    }
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes[handle] ?? null
    )
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    conversationId = generateId('peerconv')
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function peerCall(
    method: string,
    params: Record<string, unknown>,
    options: { requestId?: string; conversation?: string } = {}
  ): Promise<RpcResponse> {
    sequence += 1
    return dispatcher.dispatch(
      {
        id: `peer_${sequence}`,
        authToken: 'token',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationPeerRun: {
          runId: 'run_home',
          conversationId: options.conversation ?? conversationId,
          label: 'devA'
        },
        ...(options.requestId ? { orchestrationRequestId: options.requestId } : {})
      },
      PAIRED
    )
  }

  function peerRunId(): string {
    return db.getPeerRunForConversation(conversationId)!.run_id
  }

  async function pull(id: string, params: Record<string, unknown> = {}) {
    const response = await dispatcher.dispatch(
      {
        id,
        authToken: 'token',
        method: 'orchestration.peerMailPull',
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      PAIRED
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pull's result schema; a refusal reads as an empty page.
    return (response.ok ? response.result : { items: [] }) as {
      items: { conversationId: string; kind: string }[]
    }
  }

  it('gives every conversation a share of each pull, so an unimportable head starves no other', async () => {
    const stuck = conversationId
    const other = generateId('peerconv')
    await peerCall('orchestration.runCurrent', {})
    await peerCall('orchestration.runCurrent', {}, { conversation: other })
    const stuckRun = db.getPeerRunForConversation(stuck)!.run_id
    const otherRun = db.getPeerRunForConversation(other)!.run_id
    for (let index = 0; index < 60; index += 1) {
      db.insertMessage({
        from: 'term_w',
        to: `run:${stuckRun}`,
        subject: `s${index}`,
        runId: stuckRun
      })
    }
    db.insertMessage({ from: 'term_w', to: `run:${otherRun}`, subject: 'done', runId: otherRun })

    const items = await pull('pull')
    expect(items.items.filter((item) => item.conversationId === other)).toEqual([
      expect.objectContaining({ kind: 'worker_mail' })
    ])
  })

  it('rotates the page when more conversations are pending than it holds, so none starves', async () => {
    const conversations = Array.from({ length: 51 }, () => generateId('peerconv'))
    for (const conversation of conversations) {
      await peerCall('orchestration.runCurrent', {}, { conversation })
      const runId = db.getPeerRunForConversation(conversation)!.run_id
      db.insertMessage({ from: 'term_w', to: `run:${runId}`, subject: 'stuck', runId })
    }
    const seen = new Set<string>()
    for (const id of ['pull_1', 'pull_2']) {
      for (const item of (await pull(id)).items) {
        seen.add(item.conversationId)
      }
    }
    expect(seen.size).toBe(51)
  })

  it('wakes a waiting pull when a worker in its Run changes state', async () => {
    await peerCall('orchestration.runCurrent', {})
    const task = db.createTask({ spec: 'peer work', runId: peerRunId() })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 5
    })
    db.acknowledgeFederationRelay({
      dispatchId: conversationId,
      direction: 'to_home',
      throughSequence: 1_000
    })
    // The pull's own deadline never passes, so only the state change can answer it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const waiting = pull('pull', { waitMs: 20_000 })
    await new Promise((resolve) => setImmediate(resolve))
    db.transitionLifecycle({ entity: 'worker', id: dispatch.id, from: 'starting', to: 'ready' })

    expect((await waiting).items).toEqual([expect.objectContaining({ kind: 'worker_state' })])
  })
})
