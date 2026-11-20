import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import Database from '../sqlite/sync-database'
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
  botMessageBody: (text: string, options?: { images?: readonly { path: string }[] }) => ({
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      ...(options?.images ?? []).map(({ path }) => ({ type: 'image-ref' as const, path }))
    ]
  }),
  requireStructuredHost: async () => ({
    // The whole snapshot answers each bounded read: it holds every row a window would.
    journalReads: async (sessionId: string) => ({
      operationWindow: async () => ({ complete: true, snapshot: await mocks.snapshot(sessionId) }),
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
const databases: Database[] = []
export function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
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
      getMessageById: (id: string) => mails.get(id),
      getBotRequest: (id: string) => requests.get(id),
      getActiveDispatchForIdentity: () => undefined,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native adapters are mocked and this fixture supplies every runtime member reached by the group service.
  const runtime = partialRuntime as unknown as OrcaRuntimeService
  return {
    db,
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
