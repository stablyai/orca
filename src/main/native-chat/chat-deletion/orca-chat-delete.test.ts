import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  records: [] as { sessionId: string; createdAt: number; location: object; lastTurn?: object }[],
  owners: new Map<string, string[]>(),
  openDispatches: [] as { id: string }[],
  workers: [] as { dispatchId: string; state: string }[],
  transcripts: [] as {
    agent: string
    sessionId: string
    filePath: string
    executionHostId: string
  }[],
  closed: [] as string[],
  forgotten: [] as string[],
  deleteResult: { deleted: 1, failed: 0, freedBytes: 0 },
  shouldDelete: [] as boolean[]
}))

vi.mock('../agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    deps: {
      store: {
        readOnly: false,
        getRecord: (id: string) => mocks.records.find((record) => record.sessionId === id),
        listRecords: () => mocks.records
      }
    }
  })
}))
vi.mock(
  '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage',
  () => ({
    readAgentSessionRecordStore: () => null
  })
)
vi.mock('../../ai-vault/structured-sessions/history-row-ownership-lookup', () => ({
  historyRowOwnershipsLookup: () => (row: { sessionId: string }) => [
    (mocks.owners.get(row.sessionId) ?? []).map((sessionId) => ({ sessionId }))
  ]
}))
vi.mock('../../ai-vault/listing/cached-session-list', () => ({
  listAiVaultSessions: async () => ({ sessions: mocks.transcripts })
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/session-workers-method', () => ({
  readDispatchWorkers: async () => mocks.workers
}))
vi.mock('../../runtime/agent-session/lifecycle/structured-agent-session-close', () => ({
  closeStructuredAgentSessionChild: async (sessionId: string) => {
    mocks.closed.push(sessionId)
    return { stopped: true }
  }
}))
vi.mock('../../workspaces/cleanup/chat-history/deleted-workspace-native-chats', () => ({
  forgetNativeChatInLane: async (record: { sessionId: string }) => {
    mocks.forgotten.push(record.sessionId)
    mocks.records = mocks.records.filter((entry) => entry.sessionId !== record.sessionId)
    for (const [key, ids] of mocks.owners) {
      mocks.owners.set(
        key,
        ids.filter((id) => id !== record.sessionId)
      )
    }
    return 'forgotten'
  }
}))
vi.mock('../../workspaces/cleanup/chat-history/deleted-workspace-chat-history', () => ({
  deleteHostChatTranscriptsPermanently: async (
    _store: unknown,
    targets: { agent: string; filePath: string }[],
    shouldDelete: (target: { agent: string; filePath: string }) => Promise<boolean>
  ) => {
    for (const target of targets) {
      mocks.shouldDelete.push(await shouldDelete(target))
    }
    return mocks.deleteResult
  }
}))
vi.mock('../../bots/bot-session-tabs', () => ({ botOfSession: () => null }))
vi.mock('../../bots/bot-chat-session', () => ({ runtimeBotChats: () => ({}) }))
vi.mock('../../runtime/rpc/methods/orchestration/messaging/bot-request-outcome', () => ({
  dropUnreadBotRequests: async () => undefined
}))

import { deleteOrcaChat } from './orca-chat-delete'

const runtime = {
  ensureStructuredAgentSessionHost: async () => undefined,
  getOrchestrationDb: () => ({ listDispatchesCreatedByAny: () => mocks.openDispatches }),
  requireStore: () => ({}),
  bots: { list: () => [] }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every runtime member the delete reads.
const deleteChat = (id: string) => deleteOrcaChat(runtime as never, id)

const location = { executionHostId: 'local', wslDistro: null, workspaceKind: 'folder' }

beforeEach(() => {
  mocks.records = [{ sessionId: 'chat-a', createdAt: 1, location }]
  mocks.owners = new Map()
  mocks.openDispatches = []
  mocks.workers = []
  mocks.transcripts = []
  mocks.closed = []
  mocks.forgotten = []
  mocks.deleteResult = { deleted: 1, failed: 0, freedBytes: 0 }
  mocks.shouldDelete = []
})

describe('deleteOrcaChat', () => {
  it('refuses a chat with an unsettled worker it cannot prove ended, before touching it', async () => {
    mocks.openDispatches = [{ id: 'd-1' }]
    mocks.workers = [{ dispatchId: 'd-1', state: 'unverifiable' }]

    expect(await deleteChat('chat-a')).toEqual({ outcome: 'refused', reason: 'workers' })
    expect(mocks.closed).toEqual([])
    expect(mocks.forgotten).toEqual([])
  })

  it('refuses a group room member chat, which the room still sends to', async () => {
    mocks.records = [{ sessionId: 'bot-group-member-1', createdAt: 1, location }]

    expect(await deleteChat('bot-group-member-1')).toEqual({ outcome: 'refused', reason: 'group' })
    expect(mocks.forgotten).toEqual([])
  })

  it('keeps a transcript another chat still holds', async () => {
    mocks.records.push({ sessionId: 'chat-b', createdAt: 2, location })
    mocks.records[0] = { ...mocks.records[0], launchDirectory: '/home' } as never
    mocks.transcripts = [
      { agent: 'claude', sessionId: 'p-1', filePath: '/t/p-1.jsonl', executionHostId: 'local' }
    ]
    mocks.owners.set('p-1', ['chat-a', 'chat-b'])

    expect(await deleteChat('chat-a')).toEqual({ outcome: 'deleted' })
    expect(mocks.shouldDelete).toEqual([])
  })

  it('reports a transcript it could not remove', async () => {
    mocks.records[0] = { ...mocks.records[0], launchDirectory: '/home' } as never
    mocks.transcripts = [
      { agent: 'opencode', sessionId: 'p-1', filePath: '/t/db#p-1', executionHostId: 'local' }
    ]
    mocks.owners.set('p-1', ['chat-a'])
    mocks.deleteResult = { deleted: 0, failed: 1, freedBytes: 0 }

    expect(await deleteChat('chat-a')).toEqual({ outcome: 'deleted', historyKept: true })
    expect(mocks.shouldDelete).toEqual([true])
  })
})
