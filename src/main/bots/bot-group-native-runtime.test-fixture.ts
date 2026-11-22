import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makeTestBot } from './bot.test-fixture'
import { BotGroupRuntime } from './bot-group-runtime'
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  snapshot: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  sendAnswer: vi.fn()
}))
vi.mock('./bot-chat-session', () => ({
  startBotSession: (...args: unknown[]) => mocks.create(...args),
  botMessageBody: (
    text: string,
    options?: {
      images?: readonly { path: string }[]
      memorySource?: string
      automationRun?: object
    }
  ) => ({
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      ...(options?.images ?? []).map(({ path }) => ({ type: 'image-ref' as const, path }))
    ],
    ...(options?.memorySource ? { memorySource: options.memorySource } : {}),
    ...(options?.automationRun
      ? { origin: 'automation-run', automationRun: options.automationRun }
      : {})
  }),
  requireStructuredHost: async () => ({
    // The whole snapshot answers each bounded read: it holds every row a window would.
    journalReads: async (sessionId: string) => ({
      operationWindow: async () => ({ complete: true, snapshot: await mocks.snapshot(sessionId) }),
      // The send whose user row `rowId` is: what a turn's root row resolves to.
      acceptedSendOfRow: async (rowId: string | null) => {
        const journal: { submissions: { clientMessageId: string }[] } =
          await mocks.snapshot(sessionId)
        return (
          journal.submissions.find(
            (submission) => agentJournalSubmissionKey(submission.clientMessageId) === rowId
          ) ?? null
        )
      },
      operationSent: async (operationId: string) => {
        const journal: { submissions: { clientMessageId: string; queuedMessageId?: string }[] } =
          await mocks.snapshot(sessionId)
        return journal.submissions.some(
          (submission) =>
            submission.clientMessageId === operationId || submission.queuedMessageId === operationId
        )
      }
    }),
    sendAnswer: mocks.sendAnswer,
    setUserConversationName: async () => {},
    cancel: mocks.cancel,
    deps: { store: { requireWritableRecord: () => ({ lease: { runtimeFence: 1 } }) } }
  })
}))
vi.mock('../runtime/orchestration/turn-delivery/send-agent-turn', () => ({
  sendAgentTurn: (...args: unknown[]) => mocks.send(...args)
}))
vi.mock('../runtime/agent-session/lifecycle/structured-agent-session-close', () => ({
  closeStructuredAgentSessionChild: (...args: unknown[]) => mocks.close(...args)
}))
const databases: OrchestrationDb[] = []
export function fixture() {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const { db } = orchestration
  const bots = ['Scout', 'Forge', 'Sage'].map((name, index) =>
    makeTestBot({
      id: `bot-${index}`,
      name,
      agent: index === 1 ? 'codex' : 'claude',
      hostId: 'local',
      folderWorkspaceId: `folder-${index}`,
      avatar: null,
      paused: false
    })
  )
  const mails = new Map<
    string,
    { id: string; from_handle: string; thread_id: string | null; type?: string; read?: number }
  >()
  const requests = new Map<string, { record: string }>()
  /** Operation ids the mail lane still holds an attempt under. */
  const heldSends = new Set<string>()
  const markAsDelivered = vi.fn<(ids: string[], handle: string) => void>()
  let homeCount = 0
  const homes = {
    create: vi.fn(async (name: string) => ({
      folder: `group-${name.toLowerCase()}-${++homeCount}`,
      folderWorkspaceId: `group-home-${homeCount}`
    })),
    remove: vi.fn(async (_folderWorkspaceId: string) => {}),
    update: vi.fn(async (_folderWorkspaceId: string, _updates: { isUnread?: boolean }) => null)
  }
  const partialRuntime = {
    getOrchestrationDb: () => ({
      db,
      getMessageById: (id: string) => mails.get(id) ?? orchestration.getMessageById(id),
      getBotRequest: (id: string) => requests.get(id),
      getActiveDispatchForIdentity: (handle: string) =>
        orchestration.getActiveDispatchForIdentity(handle),
      holdsStructuredMailSendOperation: (_sessionId: string, operationId: string) =>
        heldSends.has(operationId),
      markAsDelivered
    }),
    bots: {
      list: () => bots,
      assertEnabled: () => {},
      enabled: () => true,
      createGroupHome: homes.create
    },
    deleteFolderWorkspace: homes.remove,
    updateFolderWorkspace: homes.update,
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    notifyBotGroupsChanged: vi.fn()
  }
  /** A worker on its own terminal, as `worker-start` records it; mail it sends is from that terminal. */
  const startWorker = (handle: string) => {
    const run = orchestration.createRun({
      objective: 'group work',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const task = orchestration.createTask({ runId: run.id, spec: 'work' })
    const { dispatch } = orchestration.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 8,
      taskId: task.id,
      startOptions: { agent: 'codex' }
    })
    orchestration.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle,
      paneKey: `tab_${handle}:leaf`,
      processIncarnation: 'p:1',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_applicable'
    })
    orchestration.markWorkerDispatchReady(dispatch.id)
    const send = (to: string, type: 'status' | 'worker_done') =>
      orchestration.insertMessage({
        from: handle,
        to,
        subject: type,
        type,
        runId: run.id,
        senderDispatchId: dispatch.id
      })
    return { dispatchId: dispatch.id, send }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native adapters are mocked and this fixture supplies every runtime member reached by the group service.
  const runtime = partialRuntime as unknown as OrcaRuntimeService
  return {
    db,
    orchestration,
    startWorker,
    runtime,
    bots,
    mails,
    requests,
    heldSends,
    markAsDelivered,
    homes,
    groups: new BotGroupRuntime(runtime)
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockImplementation(async (_runtime, _bot, input) => input?.sessionId ?? randomUUID())
  mocks.snapshot.mockImplementation(async (sessionId) => ({
    sessionId,
    cursor: { epoch: 'e', sequence: 0 },
    items: [],
    submissions: []
  }))
  mocks.send.mockResolvedValue({ kind: 'sent' })
  mocks.cancel.mockResolvedValue({ ok: true })
  mocks.sendAnswer.mockResolvedValue({ kind: 'waiting' })
  mocks.close.mockResolvedValue({ stopped: true })
})
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

export function groupNativeMocks(): {
  send: Mock
  snapshot: Mock
  close: Mock
  create: Mock
  cancel: Mock
  sendAnswer: Mock
} {
  return mocks
}

/** A member's journal with each given operation answered and completed at its time. */
export function journal(
  sessionId: string,
  replies: { operationId: string; text: string; at: number }[]
) {
  const stamp = { sequence: 1, revision: 1, observedAt: 1 }
  return {
    sessionId,
    cursor: { epoch: 'e', sequence: 1 },
    // Each operation's send, accepted, so its turn maps back to the operation.
    submissions: replies.map(({ operationId }) => ({
      clientMessageId: operationId,
      fence: 1,
      payloadFingerprint: operationId,
      dispatchState: 'accepted' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 1
    })),
    items: replies.flatMap(({ operationId, text, at }) => {
      const key = agentJournalSubmissionKey(operationId)
      return [
        {
          ...stamp,
          itemId: key,
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] }
        },
        {
          ...stamp,
          itemId: `turn-${operationId}`,
          body: {
            kind: 'turn' as const,
            turnId: `t-${operationId}`,
            state: 'completed' as const,
            userItemId: key,
            completedAt: at
          }
        },
        {
          ...stamp,
          itemId: `reply-${operationId}`,
          turnScope: { kind: 'turn' as const, turnItemId: `turn-${operationId}` },
          body: {
            kind: 'message' as const,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text }]
          }
        }
      ]
    })
  }
}
