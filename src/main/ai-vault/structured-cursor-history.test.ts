import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  appendStructuredCursorHistory as appendHistory,
  type StructuredCursorHistorySource
} from './structured-cursor-history'

const listRecords = vi.fn<StructuredCursorHistorySource['listRecords']>()
const history = vi.fn<StructuredCursorHistorySource['history']>()
const resolveWorkspacePath =
  vi.fn<NonNullable<StructuredCursorHistorySource['resolveWorkspacePath']>>()
const source: StructuredCursorHistorySource = {
  listRecords,
  history,
  resolveWorkspacePath,
  stateDirectory: '/profile'
}
const appendStructuredCursorHistory = (...args: Parameters<typeof appendHistory>) =>
  appendHistory(args[0], args[1], args[2], source)
const result: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-10-02T00:00:00Z' }
function record(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture()),
    sessionId: 'native-cursor',
    provider: 'cursor',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder:test',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CURSOR_CONFIG_DIR', path: '/account/cursor' },
    providerHandleChain: [
      {
        linkId: 'cursor-link',
        handle: { provider: 'cursor', sessionId: 'actual-provider-id' },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  listRecords.mockReturnValue([record()])
  resolveWorkspacePath.mockResolvedValue('/folder')
  history.mockResolvedValue({
    sessionId: 'native-cursor',
    epoch: 'epoch',
    direction: 'tail',
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch', sequence: 1 } },
    hasNewer: false,
    items: [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Saved ask' }] }
      }
    ],
    hasOlder: true
  })
})
describe('native Cursor History projection', () => {
  it('lists the exact ACP identity and existing journal preview for a folder workspace', async () => {
    expect(await appendStructuredCursorHistory(result, true)).toMatchObject({
      sessions: [
        {
          agent: 'cursor',
          sessionId: 'actual-provider-id',
          cwd: '/folder',
          resumeCommand: '',
          structuredSession: { sessionId: 'native-cursor', workspaceId: 'folder:test' },
          previewMessages: [{ role: 'user', text: 'Saved ask' }],
          previewMessagesTruncated: true
        }
      ]
    })
    expect(history).toHaveBeenCalledWith('native-cursor')
  })
  it('reads no native journal for a client without the Cursor capability', async () => {
    expect(await appendStructuredCursorHistory(result, false)).toBe(result)
    expect(listRecords).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })
  it('does not duplicate an already projected native conversation', async () => {
    const first = await appendStructuredCursorHistory(result, true)
    history.mockClear()
    expect((await appendStructuredCursorHistory(first, true)).sessions).toHaveLength(1)
    expect(history).not.toHaveBeenCalled()
  })
  it('never reads an unsupported WSL or unproven provider session', async () => {
    listRecords.mockReturnValue([
      { ...record(), location: { ...record().location, wslDistro: 'Ubuntu' } },
      { ...record(), providerHandleChain: [] }
    ])
    expect((await appendStructuredCursorHistory(result, true)).sessions).toEqual([])
    expect(history).not.toHaveBeenCalled()
  })
  it('reports a journal failure without inventing conversation content', async () => {
    history.mockRejectedValue(new Error('journal unavailable'))
    expect(await appendStructuredCursorHistory(result, true)).toMatchObject({
      sessions: [],
      issues: [{ agent: 'cursor', message: 'journal unavailable' }]
    })
  })
  it('bounds native journal reads by requested recency, while retaining older scoped conversations', async () => {
    const recent = {
      ...record(),
      sessionId: 'recent',
      location: { ...record().location, workspaceId: 'recent-folder' },
      updatedAt: 200
    }
    const older = {
      ...record(),
      sessionId: 'older',
      location: { ...record().location, workspaceId: 'older-folder' },
      updatedAt: 100
    }
    listRecords.mockReturnValue([older, recent])
    resolveWorkspacePath.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'older-folder' ? '/older' : '/recent'
    )
    expect(
      (await appendStructuredCursorHistory(result, true, { limit: 1 })).sessions.map(
        (session) => session.structuredSession?.sessionId
      )
    ).toEqual(['recent'])
    expect(history).toHaveBeenCalledTimes(1)
    history.mockClear()
    expect(
      (
        await appendStructuredCursorHistory(result, true, { limit: 1, scopePaths: ['/older'] })
      ).sessions.map((session) => session.structuredSession?.sessionId)
    ).toEqual(['recent', 'older'])
    expect(history).toHaveBeenCalledTimes(2)
  })
})
