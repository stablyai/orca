import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrchestrationWorkerServer } from '../runtime/orchestration/federation/environment-transport'
import { importRemoteOwnedItem } from '../runtime/orchestration/db/remote-owned/remote-owned-import'
import {
  recordRemoteStart,
  reserveRemotePlacement
} from '../runtime/orchestration/db/remote-owned/remote-placements'
import {
  openRemoteRunLink,
  remoteServerPin
} from '../runtime/orchestration/db/remote-owned/remote-run-links'
import type { BotWorkRecord } from './bot-work-record'
import { botWorkHostOf, prepareBotWorkerStart, runtimeBotWork } from './bot-work-runtime'

let userData = ''
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => userData
}))

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_b',
  name: 'devB',
  peerFingerprint: 'host_b',
  homePeerFingerprint: 'cred_a',
  pairingRevision: 1
}
const TURN = { botId: 'bot-1', address: { source: 'slack', externalId: 'T1:C1:1.0' } } as const

describe("a bot's worker-start --on a server that owns its workers", () => {
  let db: OrchestrationDb
  let openedBotWork: BotWorkRecord | undefined

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'bot-work-server-owned-'))
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    openedBotWork?.store().dispose()
    openedBotWork = undefined
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('keeps the row on that server while the worker runs, brings its report home, and closes when it stops', async () => {
    const run = db.createRun({
      objective: 'Ship',
      coordinatorHandle: 'term_bot',
      coordinatorPaneKey: null
    })
    const link = openRemoteRunLink(db, run.id, SERVER)
    const bots = { list: () => [{ folderWorkspaceId: 'home' }] }
    const runtime = {
      getOrchestrationDb: () => db,
      resolveOrchestrationWorkerServer: () => SERVER,
      bots,
      linkStore: () => null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a server-owned worker reads only these members.
    const botWork = runtimeBotWork(runtime as unknown as Parameters<typeof runtimeBotWork>[0])
    openedBotWork = botWork

    const recordStart = prepareBotWorkerStart(
      {
        bots,
        botWork: { turnOf: async () => TURN, started: (...args) => botWork.started(...args) },
        hostOf: (dispatchId) => botWorkHostOf(db, dispatchId)
      },
      { sessionId: 'bot-session', workspaceId: 'folder:home' }
    )
    reserveRemotePlacement(db, {
      link,
      taskId: 'task_on_b',
      requestKey: 'key_on_b',
      create: { spec: 'Fix the login bug' }
    })
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId: 'task_on_b',
      dispatchId: 'ctx_on_b',
      requestKey: 'key_on_b',
      peerRunId: 'run_on_b'
    })
    recordStart({ taskId: 'task_on_b', dispatchId: 'ctx_on_b' })
    await vi.waitFor(() => expect(botWork.store().liveRows('bot-1')).toHaveLength(1))
    expect(botWork.store().liveRows('bot-1')[0]).toMatchObject({ host: 'env_b' })

    let sequence = 0
    const pull = (kind: 'worker_state' | 'worker_mail', payload: Record<string, unknown>) =>
      importRemoteOwnedItem(db, remoteServerPin(SERVER), {
        conversationId: link.conversation_id,
        sequence: ++sequence,
        messageId: `item_${sequence}`,
        kind,
        payload: JSON.stringify({
          v: 1,
          id: `item_${sequence}`,
          homeRunId: run.id,
          peerRunId: 'run_on_b',
          ...payload
        })
      })
    const workerState = (workerState: string, taskStatus: string) =>
      pull('worker_state', {
        dispatch: {
          id: 'ctx_on_b',
          taskId: 'task_on_b',
          status: 'dispatched',
          workerState,
          lastFailure: null,
          agent: 'claude'
        },
        task: { status: taskStatus, result: null },
        correctedUnobservedPrompt: false,
        removed: null
      })

    workerState('working', 'dispatched')
    expect(await botWork.list('bot-1')).toEqual([
      expect.objectContaining({
        dispatchId: 'ctx_on_b',
        title: 'Fix the login bug',
        state: 'working',
        server: 'devB'
      })
    ])

    pull('worker_mail', {
      message: {
        from: 'dispatch:ctx_on_b',
        type: 'worker_done',
        subject: 'Fixed the login bug',
        body: 'PR opened',
        payload: null,
        priority: 'normal',
        threadId: null
      },
      dispatchId: 'ctx_on_b',
      taskId: 'task_on_b'
    })
    expect(db.getUnreadMessages(`run:${run.id}`)).toEqual([
      expect.objectContaining({ type: 'worker_done', subject: 'Fixed the login bug' })
    ])

    workerState('stopped', 'dispatched')
    expect(await botWork.list('bot-1')).toEqual([])
    expect(botWork.store().liveRows('bot-1')).toEqual([])
  })
})
