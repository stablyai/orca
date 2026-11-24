import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => null
}))
vi.mock('../../git/command-runner/git-exec-file', () => ({
  gitExecFileAsync: vi.fn()
}))

import type { Repo } from '../../../shared/repository/repo-types'
import { findAutomationRepo } from '../../../shared/automations/ownership/automation-repo-target'
import { applyAgentSessionRecordCommand } from '../agent-session/records/agent-session-record-command'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { listOpenChatSessionIds, restoreOrphanedChats } from './orphaned-chat-restore'
import { beginProjectRemoval, resetRemovedProjectLedgerForTests } from './removed-project-ledger'

const OLD = '382f7d9d-4836-4375-9a02-529501637cc7'
const NEW = '7319a84d-f391-4530-b66d-b3ca61acfbb6'
const PATH = '/work/app'

const oldRepo: Repo = { id: OLD, path: PATH, kind: 'git' } as Repo
const newRepo: Repo = { id: NEW, path: PATH, kind: 'git' } as Repo

function chatStore(workspaceId = `${OLD}::${PATH}`) {
  const records = [{ sessionId: 'chat-1', location: { executionHostId: 'local', workspaceId } }]
  const updateRecord = vi.fn(
    async (sessionId: string, command: { kind: 'workspace'; from: string; to: string }) => {
      const record = records.find((entry) => entry.sessionId === sessionId)
      if (record && record.location.workspaceId === command.from) {
        record.location.workspaceId = command.to
      }
    }
  )
  return { records, updateRecord, listConversations: () => records }
}

const sameRepo = async (): Promise<string> => 'git:root-a'
const otherRepo = async (): Promise<string> => 'git:root-b'

describe('restoreOrphanedChats', () => {
  beforeEach(() => resetRemovedProjectLedgerForTests())

  it('moves the removed project chats to the new id', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    const store = chatStore()
    const moved = await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => store,
      readIdentity: sameRepo
    })
    expect(moved).toBe(1)
    expect(store.records[0].location.workspaceId).toBe(`${NEW}::${PATH}`)
  })

  it('automations of the removed project stay unavailable after the re-add', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => chatStore(),
      readIdentity: sameRepo
    })
    // Automations name the old id; the re-added project has a new one, so nothing can run them.
    expect(newRepo.id).not.toBe(OLD)
    expect(findAutomationRepo([newRepo], OLD, { hostId: 'local', path: PATH })).toBeUndefined()
    expect(findAutomationRepo([newRepo], OLD)).toBeUndefined()
  })

  it('a different repository cloned to the same path does not inherit chats', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    const store = chatStore()
    const moved = await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => store,
      readIdentity: otherRepo
    })
    expect(moved).toBe(0)
    expect(store.updateRecord).not.toHaveBeenCalled()
    expect(store.records[0].location.workspaceId).toBe(`${OLD}::${PATH}`)
  })

  it('a re-add during the removal waits until the removal has finished', async () => {
    const finishRemoval = beginProjectRemoval(oldRepo, sameRepo)
    const store = chatStore()
    const restoring = restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => store,
      readIdentity: sameRepo
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The removal is still closing chats by the old id: nothing has been moved yet.
    expect(store.updateRecord).not.toHaveBeenCalled()
    expect(store.records[0].location.workspaceId).toBe(`${OLD}::${PATH}`)
    finishRemoval()
    expect(await restoring).toBe(1)
    expect(store.records[0].location.workspaceId).toBe(`${NEW}::${PATH}`)
  })

  it('moves nothing when the re-added project was removed again meanwhile', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    const store = chatStore()
    expect(
      await restoreOrphanedChats(newRepo, {
        isLive: () => false,
        chatStore: () => store,
        readIdentity: sameRepo
      })
    ).toBe(0)
    expect(store.updateRecord).not.toHaveBeenCalled()
  })

  it('a removed project is claimed once', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => chatStore(),
      readIdentity: sameRepo
    })
    const second = chatStore()
    const third = { ...newRepo, id: '99999999-0000-0000-0000-000000000000' } as Repo
    expect(
      await restoreOrphanedChats(third, {
        isLive: (id) => id === third.id,
        chatStore: () => second,
        readIdentity: sameRepo
      })
    ).toBe(0)
  })
})

describe('chats that were open when the project was removed', () => {
  beforeEach(() => resetRemovedProjectLedgerForTests())

  const twoChats = () => {
    const records = ['chat-1', 'chat-2', 'chat-3'].map((sessionId) => ({
      sessionId,
      location: { executionHostId: 'local', workspaceId: `${OLD}::${PATH}` }
    }))
    return {
      records,
      listConversations: () => records,
      updateRecord: vi.fn(
        async (sessionId: string, command: { kind: 'workspace'; from: string; to: string }) => {
          const record = records.find((entry) => entry.sessionId === sessionId)
          if (record) {
            record.location.workspaceId = command.to
          }
        }
      )
    }
  }

  it('lists the open chat tabs of one project in tab order', () => {
    const host = {
      listSessionTabs: () => [
        { sessionId: 'a', workspaceId: `${OLD}::${PATH}` },
        { sessionId: 'b', workspaceId: `${NEW}::/other` },
        { sessionId: 'c', workspaceId: `${OLD}::${PATH}--x` }
      ]
    }
    expect(listOpenChatSessionIds(OLD, () => host)).toEqual(['a', 'c'])
    expect(listOpenChatSessionIds(OLD, () => null)).toEqual([])
  })

  it('reopens, in the old order, only the chats whose tabs the removal closed', async () => {
    beginProjectRemoval(oldRepo, sameRepo, ['chat-2', 'chat-1'])()
    const showSessionTabs = vi.fn(async () => {})
    await restoreOrphanedChats(newRepo, {
      isLive: (id) => id === NEW,
      chatStore: () => twoChats(),
      chatTabs: () => ({ showSessionTabs }),
      readIdentity: sameRepo
    })
    expect(showSessionTabs).toHaveBeenCalledTimes(1)
    expect(showSessionTabs).toHaveBeenCalledWith(['chat-2', 'chat-1'])
  })

  it('reopens nothing when no chat was open, and a failed reopen does not throw', async () => {
    beginProjectRemoval(oldRepo, sameRepo)()
    const showSessionTabs = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      restoreOrphanedChats(newRepo, {
        isLive: (id) => id === NEW,
        chatStore: () => twoChats(),
        chatTabs: () => ({ showSessionTabs }),
        readIdentity: sameRepo
      })
    ).resolves.toBe(3)
    expect(showSessionTabs).not.toHaveBeenCalled()
    resetRemovedProjectLedgerForTests()
    beginProjectRemoval(oldRepo, sameRepo, ['chat-1'])()
    await expect(
      restoreOrphanedChats(newRepo, {
        isLive: (id) => id === NEW,
        chatStore: () => twoChats(),
        chatTabs: () => ({ showSessionTabs }),
        readIdentity: sameRepo
      })
    ).resolves.toBe(3)
  })
})

describe('workspace record command', () => {
  const record = (workspaceId: string) =>
    ({
      sessionId: 'chat-1',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId,
        workspaceKind: 'worktree'
      }
    }) as unknown as AgentSessionRecord

  it('moves the chat only from the exact id it was planned against', () => {
    const moved = applyAgentSessionRecordCommand(record(`${OLD}::${PATH}`), {
      kind: 'workspace',
      from: `${OLD}::${PATH}`,
      to: `${NEW}::${PATH}`
    }).record
    expect(moved.location.workspaceId).toBe(`${NEW}::${PATH}`)
    const elsewhere = record('other::/x')
    expect(
      applyAgentSessionRecordCommand(elsewhere, {
        kind: 'workspace',
        from: `${OLD}::${PATH}`,
        to: `${NEW}::${PATH}`
      }).record
    ).toBe(elsewhere)
  })
})
