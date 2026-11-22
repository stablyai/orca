import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeRecord = {
  sessionId: string
  provider: string
  providerHandleChain: { handle: { nativeId: string } }[]
}
type Mocks = {
  records: FakeRecord[]
  loaded: Set<string>
  /** Sessions a send reopens right after their stop, once each. */
  reopens: Set<string>
  stopped: string[]
  forgets: unknown[]
  storeAccepts: boolean
  owesDispatch: boolean
  bot: { id: string; chatSessionId: string } | null
  dropped: string[]
}

const mocks = vi.hoisted((): Mocks => ({
  records: [],
  loaded: new Set(),
  reopens: new Set(),
  stopped: [],
  forgets: [],
  storeAccepts: true,
  owesDispatch: false,
  bot: null,
  dropped: []
}))

vi.mock('../agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    hasSession: (id: string) => mocks.loaded.has(id),
    isSessionTabVisible: () => false,
    deps: {
      hasOpenDispatch: () => mocks.owesDispatch,
      store: {
        readOnly: false,
        getRecord: (id: string) => mocks.records.find((record) => record.sessionId === id),
        listRecords: () => mocks.records,
        forgetChat: async (forget: unknown) => {
          mocks.forgets.push(forget)
          return mocks.storeAccepts
        }
      }
    }
  })
}))
vi.mock(
  '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage',
  () => ({ readAgentSessionRecordStore: () => null })
)
// Every record is one lineage, as a committed /clear makes it.
vi.mock('../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id', () => ({
  createCanonicalOrcaSessionResolver: () => () => 'chat-root'
}))
vi.mock('../../../shared/agent-session/identity/orca-session-address', () => ({
  isOrcaSessionId: () => true
}))
vi.mock('../../runtime/agent-session/lifecycle/structured-agent-session-close', () => ({
  closeStructuredAgentSessionChild: async (sessionId: string) => {
    mocks.stopped.push(sessionId)
    mocks.loaded.delete(sessionId)
    if (mocks.reopens.delete(sessionId)) {
      // The send that reopened it resumed a new provider conversation.
      mocks.loaded.add(sessionId)
      mocks.records = mocks.records.map((entry) =>
        entry.sessionId === sessionId
          ? {
              ...entry,
              providerHandleChain: [
                ...entry.providerHandleChain,
                { handle: { nativeId: 'conv-3' } }
              ]
            }
          : entry
      )
    }
    return { stopped: true }
  }
}))
vi.mock('../../bots/bot-session-tabs', () => ({ botOfSession: () => mocks.bot }))
vi.mock('../../runtime/rpc/methods/orchestration/messaging/bot-request-outcome', () => ({
  dropUnreadBotRequests: async (_runtime: unknown, _bot: string, _why: string, id: string) => {
    mocks.dropped.push(id)
  }
}))

import { deleteOrcaChat } from './orca-chat-delete'

const runtime = {
  ensureStructuredAgentSessionHost: async () => undefined,
  bots: { list: () => [] }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every runtime member the delete reads.
const deleteChat = (id: string) => deleteOrcaChat(runtime as never, id)

const record = (sessionId: string, nativeId: string): FakeRecord => ({
  sessionId,
  provider: 'claude',
  providerHandleChain: [{ handle: { nativeId } }]
})

beforeEach(() => {
  mocks.records = [record('chat-root', 'conv-1'), record('chat-next', 'conv-2')]
  mocks.loaded = new Set()
  mocks.reopens = new Set()
  mocks.stopped = []
  mocks.forgets = []
  mocks.storeAccepts = true
  mocks.owesDispatch = false
  mocks.bot = null
  mocks.dropped = []
})

describe('deleteOrcaChat', () => {
  it('stops a running chat, then forgets its whole /clear lineage in one commit', async () => {
    mocks.loaded.add('chat-next')

    expect(await deleteChat('chat-root')).toEqual({ outcome: 'deleted' })
    expect(mocks.stopped).toEqual(['chat-next'])
    expect(mocks.forgets).toEqual([
      {
        chatId: 'chat-root',
        sessionIds: ['chat-root', 'chat-next'],
        conversations: [
          { provider: 'claude', providerSessionId: 'conv-1' },
          { provider: 'claude', providerSessionId: 'conv-2' }
        ]
      }
    ])
  })

  it('stops a chat a send reopened before the commit again, and tombstones what that send resumed', async () => {
    mocks.loaded.add('chat-root')
    mocks.reopens.add('chat-root')

    expect(await deleteChat('chat-root')).toEqual({ outcome: 'deleted' })
    expect(mocks.stopped).toEqual(['chat-root', 'chat-root'])
    expect(mocks.forgets).toEqual([
      expect.objectContaining({
        conversations: [
          { provider: 'claude', providerSessionId: 'conv-1' },
          { provider: 'claude', providerSessionId: 'conv-3' },
          { provider: 'claude', providerSessionId: 'conv-2' }
        ]
      })
    ])
  })

  it('keeps a worker chat an orchestration still waits on, without stopping its turn', async () => {
    mocks.owesDispatch = true
    mocks.loaded.add('chat-root')

    expect(await deleteChat('chat-root')).toEqual({ outcome: 'refused', reason: 'workers' })
    expect(mocks.stopped).toEqual([])
    expect(mocks.forgets).toEqual([])
  })

  it('keeps a group room member chat, which the room still sends to', async () => {
    mocks.records = [record('bot-group-member-1', 'conv-1')]

    expect(await deleteChat('bot-group-member-1')).toEqual({ outcome: 'refused', reason: 'group' })
    expect(mocks.stopped).toEqual([])
  })

  it("keeps a managed agent's live Home Chat", async () => {
    mocks.bot = { id: 'agent-1', chatSessionId: 'chat-next' }

    expect(await deleteChat('chat-root')).toEqual({ outcome: 'refused', reason: 'home' })
    expect(mocks.forgets).toEqual([])
  })

  it("tells unread mail of a managed agent's chat only after the commit", async () => {
    mocks.bot = { id: 'agent-1', chatSessionId: 'other-home' }
    mocks.storeAccepts = false

    expect(await deleteChat('chat-root')).toEqual({ outcome: 'refused', reason: 'unavailable' })
    expect(mocks.dropped).toEqual([])

    mocks.storeAccepts = true
    expect(await deleteChat('chat-root')).toEqual({ outcome: 'deleted' })
    expect(mocks.dropped).toEqual(['chat-root', 'chat-next'])
  })
})
