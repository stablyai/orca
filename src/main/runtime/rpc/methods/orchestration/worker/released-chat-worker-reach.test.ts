import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { createOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import type { SessionWorkersRuntime } from './session-workers-method'
import { readWorkspaceRetainedChats } from './workspace-retained-chats-method'

type RetainedChatsHost = Parameters<typeof readWorkspaceRetainedChats>[1]
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'

const mocks = vi.hoisted(() => {
  const state: { host: unknown; workers: Map<string, OrchestrationSessionWorker> } = {
    host: null,
    workers: new Map()
  }
  return state
})

vi.mock('./session-workers-method', () => ({
  readDispatchWorkers: async (_runtime: unknown, ids: readonly string[]) =>
    ids.flatMap((id) => mocks.workers.get(id) ?? [])
}))
vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => mocks.host })
)

describe('a workspace finished chat workers stay reachable', () => {
  let directory: string
  let db: OrchestrationDb
  let runId: string
  const openTabs = new Set<string>()
  const kept = new Set<string>()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-retained-chats-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    runId = db.createRun({
      objective: 'reach',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    openTabs.clear()
    kept.clear()
    mocks.workers.clear()
    mocks.host = null
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function finishedChatWorker(args: {
    worktreeId: string
    chat: string
    release: 'released' | 'releasing'
    followUpOf?: string
    handle?: string
  }): string {
    const task = db.createTask({ runId, spec: 'review' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: createOrcaSessionId(randomUUID) },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      ...(args.followUpOf ? { followUpOf: args.followUpOf } : {})
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: args.handle ?? `structworker_${dispatch.id}`,
      paneKey: mintStructuredWorkerPaneKey(args.chat),
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      processIncarnation: structuredWorkerProcessIncarnation(args.chat),
      worktreeId: args.worktreeId,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.db.prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`).run(dispatch.id)
    db.db
      .prepare(`UPDATE worker_terminal_resources SET release_state = ? WHERE owner_dispatch_id = ?`)
      .run(args.release, dispatch.id)
    kept.add(args.chat)
    mocks.workers.set(dispatch.id, {
      dispatchId: dispatch.id,
      taskId: task.id,
      runId,
      title: 'review',
      agent: 'codex',
      state: 'completed',
      liveness: 'exited',
      host: 'local',
      worktreeId: args.worktreeId,
      paneKey: null,
      chatSessionId: args.chat,
      startedAt: 1,
      settledAt: 2
    })
    return dispatch.id
  }

  const keptChatsHost = (): RetainedChatsHost =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read and its lineage walk use only these store members.
    ({
      isSessionTabVisible: (id: string) => openTabs.has(id),
      deps: {
        store: {
          getConversation: (id: string) =>
            kept.has(id)
              ? {
                  sessionId: id,
                  location: {
                    executionHostId: 'local',
                    wslDistro: null,
                    workspaceId: 'wt-shared',
                    workspaceKind: 'git-worktree'
                  }
                }
              : undefined,
          listConversations: () => [],
          getVisibleSessionTabIndex: () => undefined
        }
      }
    }) as unknown as RetainedChatsHost

  const runtime = (): SessionWorkersRuntime =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only the database.
    ({ getOrchestrationDb: () => db }) as unknown as SessionWorkersRuntime

  it('lists each closed chat a released worker left in this workspace, and nothing else', async () => {
    const implementation = finishedChatWorker({
      worktreeId: 'wt-shared',
      chat: 'chat-a',
      release: 'released'
    })
    const review = finishedChatWorker({
      worktreeId: 'wt-shared',
      chat: 'chat-b',
      release: 'released'
    })
    finishedChatWorker({ worktreeId: 'wt-shared', chat: 'chat-open', release: 'released' })
    openTabs.add('chat-open')
    finishedChatWorker({ worktreeId: 'wt-shared', chat: 'chat-gone', release: 'released' })
    kept.delete('chat-gone')
    finishedChatWorker({ worktreeId: 'wt-shared', chat: 'chat-releasing', release: 'releasing' })
    finishedChatWorker({ worktreeId: 'wt-other', chat: 'chat-other', release: 'released' })
    finishedChatWorker({
      worktreeId: 'wt-shared',
      chat: 'chat-terminal',
      release: 'released',
      handle: 'term_1'
    })

    const host = keptChatsHost()
    mocks.host = host
    const listed = await readWorkspaceRetainedChats(runtime(), host, 'wt-shared')

    expect(listed.map((worker) => worker.dispatchId).sort()).toEqual(
      [implementation, review].sort()
    )
  })

  it('finds an older kept chat behind a full page of open ones', async () => {
    const older = finishedChatWorker({
      worktreeId: 'wt-shared',
      chat: 'chat-old',
      release: 'released'
    })
    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET updated_at = '2000-01-01 00:00:00' WHERE owner_dispatch_id = ?`
      )
      .run(older)
    for (let i = 0; i < 60; i++) {
      finishedChatWorker({ worktreeId: 'wt-shared', chat: `chat-open-${i}`, release: 'released' })
      openTabs.add(`chat-open-${i}`)
    }
    const host = keptChatsHost()
    mocks.host = host

    const listed = await readWorkspaceRetainedChats(runtime(), host, 'wt-shared')

    expect(listed.map((worker) => worker.dispatchId)).toEqual([older])
  })

  it('names the send that reopens a worker whose chat is still being released', () => {
    const dispatchId = finishedChatWorker({
      worktreeId: 'wt-shared',
      chat: 'chat-a',
      release: 'releasing'
    })
    const row = db.getWorkerTerminalResourceByOwner(dispatchId)!

    expect(() =>
      db.findTransferableWorkerTerminalResource({
        terminalHandle: row.terminal_handle,
        paneKey: row.pane_key,
        processIncarnation: row.process_incarnation,
        hostScope: row.host_scope
      })
    ).toThrow(`orca orchestration send --to dispatch:${dispatchId}`)
  })
})
