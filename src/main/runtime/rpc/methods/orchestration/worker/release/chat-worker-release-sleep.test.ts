import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import {
  createOrcaSessionId,
  type OrcaSessionId
} from '../../../../../../../shared/agent-session/identity/orca-session-address'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import type { StructuredWorkerIdentity } from '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { stopStructuredWorkerForRelease } from './structured-worker-release-stop'
import { reopenWorkerChat } from '../follow-up/worker-follow-up-placement'

const BOT_CHAT = createOrcaSessionId(randomUUID)
const USER_CHAT = createOrcaSessionId(randomUUID)

const mocks = vi.hoisted(() => {
  const state: { close: ReturnType<typeof vi.fn>; identity: unknown; host: unknown } = {
    close: vi.fn(async () => ({ stopped: true, closeAttempted: true })),
    identity: null,
    host: null
  }
  return state
})

vi.mock(
  '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    requireRunningStructuredWorker: (identity: { sessionId: string }) => ({
      sessionId: identity.sessionId,
      lineage: [identity.sessionId]
    }),
    resolveStructuredWorkerIdentity: () => mocks.identity,
    structuredWorkerSession: (identity: { sessionId: string }) => ({
      kind: 'here',
      sessionId: identity.sessionId,
      lineage: [identity.sessionId]
    })
  })
)
vi.mock(
  '../../structured-workers/orchestration-structured-worker-lifecycle',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    stopStructuredWorker: mocks.close
  })
)
vi.mock('../../../../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) => (sessionId === BOT_CHAT ? {} : null)
}))
vi.mock(
  '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => mocks.host })
)
vi.mock('../../../../../session-tabs/chat/background-chat-tab-publication', () => ({
  publishChatTabInBackground: vi.fn(async () => {})
}))

describe('releasing a bot chat worker sleeps the workspace made for it', () => {
  let directory: string
  let db: OrchestrationDb
  let runId: string
  let sleepWorkspaces: ReturnType<typeof vi.fn>
  let forgetMail: ReturnType<typeof vi.fn>
  let runtime: WorkerTerminalReleaseRuntime
  // What the workspace holds besides the worker's own chat, and how its session lane finds the chat.
  let tabs: { type: string; sessionId?: string }[]
  let conversations: { sessionId: string; location: { workspaceId: string } }[]
  let laneWork: { sessionId: string | null; state: 'idle' | 'busy' | 'unknown' }
  let laneProvesStop: boolean
  let laneOthers: [string, typeof laneWork][]
  let autoReleaseAtSleep: (string | null)[]
  let lastDispatch = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-chat-worker-sleep-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    runId = db.createRun({
      objective: 'sleep',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    mocks.close.mockClear()
    tabs = [{ type: 'agent-session', sessionId: 'worker-chat' }]
    conversations = []
    laneWork = { sessionId: 'worker-chat', state: 'idle' }
    laneProvesStop = true
    laneOthers = []
    autoReleaseAtSleep = []
    mocks.host = {
      isSessionTabVisible: () => true,
      deps: { store: { listConversations: () => conversations, getRecord: () => ({}) } }
    }
    // Stands in for Sleep: each chat's stop asks `admit` in its session lane first.
    sleepWorkspaces = vi.fn(
      async (
        request: { targets: { worktreeId: string }[] },
        admit?: (sessionId: string, work: typeof laneWork) => boolean
      ) => {
        autoReleaseAtSleep.push(
          db.getWorkerTerminalResourceByOwner(lastDispatch)?.auto_release_at ?? null
        )
        const others = laneOthers.map(([id, work]) => !admit || admit(id, work))
        const stopped =
          (!admit || admit('worker-chat', laneWork)) && laneProvesStop && others.every(Boolean)
        return [
          {
            worktreeId: request.targets[0].worktreeId,
            chatFailed: !stopped,
            receipts: [
              { executionHostId: 'local', stoppedSessionIds: stopped ? ['worker-chat'] : [] }
            ]
          }
        ]
      }
    )
    forgetMail = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release reads only these members.
    runtime = {
      bots: { list: () => [] },
      sleepWorkspaces,
      forgetStructuredSessionMail: forgetMail,
      notifyMessageArrived: vi.fn(),
      isWorkerAgentInTurn: () => false,
      listMobileSessionTabs: async () => ({ tabs })
    } as unknown as WorkerTerminalReleaseRuntime
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function startWorker(args: {
    from: OrcaSessionId
    worktreeId: string
    createdIt: boolean
    followUpOf?: string
  }) {
    const task = db.createTask({ runId, spec: 'chat worker' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: args.from },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      ...(args.followUpOf ? { followUpOf: args.followUpOf } : {})
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: `swk_${dispatch.id}`,
      paneKey: `chat_${dispatch.id}`,
      processIncarnation: `structured:${dispatch.id}`,
      worktreeId: args.worktreeId,
      setupState: 'not_applicable',
      effects: args.createdIt
        ? [{ kind: 'worktree', id: args.worktreeId, action: 'created_child' }]
        : [],
      terminalOwnership: 'created'
    })
    db.db.prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`).run(dispatch.id)
    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET release_state = 'releasing' WHERE owner_dispatch_id = ?`
      )
      .run(dispatch.id)
    lastDispatch = dispatch.id
    return dispatch.id
  }

  function armAutoRelease(dispatchId: string) {
    db.db
      .prepare(
        `UPDATE worker_terminal_resources
            SET auto_release_at = datetime('now'), auto_release_dispatch_id = owner_dispatch_id
          WHERE owner_dispatch_id = ?`
      )
      .run(dispatchId)
    return dispatchId
  }

  async function release(dispatchId: string) {
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    const structured: StructuredWorkerIdentity = {
      handle: resource.terminal_handle,
      sessionId: 'worker-chat',
      agent: 'claude',
      paneKey: resource.pane_key ?? '',
      processIncarnation: resource.process_incarnation ?? '',
      worktreeId: resource.worktree_id ?? '',
      hostScope: { kind: 'local', hostId: 'local' }
    }
    const receipt = await stopStructuredWorkerForRelease({
      structured,
      dispatchId,
      resource,
      runtime,
      db,
      archiveSource: null,
      archiveStatus: null
    })
    return { receipt, row: db.getWorkerTerminalResource(resource.id)! }
  }

  it('sleeps instead of closing, settles the release, and drops the parked mail', async () => {
    const { receipt, row } = await release(
      startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true })
    )
    expect(sleepWorkspaces).toHaveBeenCalledWith(
      {
        targets: [
          { worktreeId: 'wt-made', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }
        ],
        markChatsAsleep: true
      },
      undefined
    )
    expect(mocks.close).not.toHaveBeenCalled()
    expect(receipt.state).toBe('released')
    expect(row.release_state).toBe('released')
    expect(forgetMail).toHaveBeenCalledWith('worker-chat')
  })

  it('sleeps again after a follow-up of the same worker finishes', async () => {
    const first = startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true })
    await release(first)
    const followUp = startWorker({
      from: BOT_CHAT,
      worktreeId: 'wt-made',
      createdIt: false,
      followUpOf: first
    })
    const { receipt } = await release(followUp)
    expect(sleepWorkspaces).toHaveBeenCalledTimes(2)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(receipt.state).toBe('released')
  })

  it('closes as before when the workspace was not made for this worker alone', async () => {
    startWorker({ from: BOT_CHAT, worktreeId: 'wt-shared', createdIt: true })
    const second = startWorker({ from: BOT_CHAT, worktreeId: 'wt-shared', createdIt: false })
    const { receipt } = await release(second)
    expect(sleepWorkspaces).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(receipt.state).toBe('released')
  })

  it('closes as before when a worker from a paired host also ran in the workspace', async () => {
    const own = startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true })
    db.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, worktree_id)
         VALUES ('ctx_remote', 'task_remote', 'peer', 'epoch', 'wt-made')`
      )
      .run()
    await release(own)
    expect(sleepWorkspaces).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  describe.each([
    ['a chat the user opened', { type: 'agent-session', sessionId: 'user-chat' }],
    ['a terminal', { type: 'terminal' }],
    ['a browser tab', { type: 'browser' }],
    ['an open file', { type: 'file' }]
  ])('a workspace that also holds %s', (_kind, tab) => {
    it('closes as before', async () => {
      tabs.push(tab)
      await release(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
      expect(sleepWorkspaces).not.toHaveBeenCalled()
      expect(mocks.close).toHaveBeenCalledTimes(1)
    })
  })

  it('closes as before when the workspace keeps another chat with no tab', async () => {
    conversations.push({ sessionId: 'hidden-chat', location: { workspaceId: 'wt-made' } })
    await release(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
    expect(sleepWorkspaces).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('judges an automatic release where Sleep stops the chat, and sleeps a resting one', async () => {
    const { receipt } = await release(
      armAutoRelease(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
    )
    // Still armed when Sleep starts: only the chat's own lane may spend the admission.
    expect(autoReleaseAtSleep[0]).not.toBeNull()
    expect(receipt.state).toBe('released')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('keeps the chat when a turn began before Sleep reached it, and never closes it', async () => {
    laneWork = { sessionId: 'worker-chat', state: 'busy' }
    const { receipt, row } = await release(
      armAutoRelease(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
    )
    expect(receipt.state).toBe('retained')
    expect(row.release_state).toBe('not_requested')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('keeps the chat when a later chat of the same worker is working', async () => {
    laneOthers = [['worker-chat-after-clear', { sessionId: null, state: 'busy' }]]
    const { receipt, row } = await release(
      armAutoRelease(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
    )
    expect(receipt.state).toBe('retained')
    expect(row.release_state).toBe('not_requested')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('does not close an admitted chat a second time when Sleep cannot prove the stop', async () => {
    laneProvesStop = false
    const { receipt } = await release(
      armAutoRelease(startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true }))
    )
    expect(receipt.state).toBe('release_unknown')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('closes as before for a worker a normal chat started', async () => {
    await release(startWorker({ from: USER_CHAT, worktreeId: 'wt-user', createdIt: true }))
    expect(sleepWorkspaces).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('falls back to closing when Sleep does not prove the chat stopped', async () => {
    sleepWorkspaces.mockResolvedValueOnce([
      { worktreeId: 'wt-made', chatFailed: true, receipts: [] }
    ])
    const { receipt } = await release(
      startWorker({ from: BOT_CHAT, worktreeId: 'wt-made', createdIt: true })
    )
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(receipt.state).toBe('released')
  })
})

describe('reopening a released worker chat', () => {
  function hostWith(visible: boolean, sleptAt: number | undefined) {
    mocks.identity = {
      handle: 'swk_1',
      sessionId: 'worker-chat',
      paneKey: 'chat_1',
      processIncarnation: 'structured:1',
      hostScope: { kind: 'local', hostId: 'local' }
    }
    mocks.host = {
      isSessionTabVisible: () => visible,
      deps: { store: { getRecord: () => ({ sleptAt }) } }
    }
  }
  const runtime: Parameters<typeof reopenWorkerChat>[0] = {
    ensureStructuredAgentSessionHost: async () => {},
    publishStructuredAgentSessionTab: async () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the identity read that takes it is mocked.
  const db = {} as OrchestrationDb

  it("keeps custody Orca's when its release left the chat asleep", async () => {
    hostWith(true, Date.now())
    expect((await reopenWorkerChat(runtime, db, 'swk_1')).userOpened).toBe(false)
  })

  it('hands custody to the user once they woke the chat', async () => {
    hostWith(true, undefined)
    expect((await reopenWorkerChat(runtime, db, 'swk_1')).userOpened).toBe(true)
  })

  it('still reopens an old released chat whose tab was hidden', async () => {
    hostWith(false, undefined)
    const reopened = await reopenWorkerChat(runtime, db, 'swk_1')
    expect(reopened).toMatchObject({ chat: true, userOpened: false })
  })
})
