import { describe, expect, it, vi } from 'vitest'
import { ConversationKnowledgeService } from './conversation-knowledge-service'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { AiVaultSessionEnrichment } from '../../shared/ai-vault-history-types'
import {
  CONVERSATION_KNOWLEDGE_FORMAT_VERSION,
  type ConversationKnowledgeItem
} from '../../shared/conversation-knowledge-items'

describe('ConversationKnowledgeService', () => {
  it('keeps the source agent separate from the configured generator agent', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies every session field read by the service.
    const session = {
      executionHostId: 'local',
      agent: 'claude',
      sessionId: 'source-session',
      title: 'Remote process semantics',
      cwd: '/code/orca',
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      modifiedAt: '2026-09-01T10:00:01.000Z'
    } as AiVaultSession
    const enrich = vi.fn().mockResolvedValue({
      summary: 'Summary',
      topics: ['SSH'],
      conclusions: ['Do not infer exit.'],
      entities: ['Orca'],
      searchTerms: ['remote disconnect'],
      agent: 'codex',
      model: 'gpt-5'
    })
    const upsert = vi.fn().mockResolvedValue(undefined)
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([session]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: { list: vi.fn().mockResolvedValue([]), upsert, remove: vi.fn() }
    })

    const item = await service.generate({
      sourceAgent: 'claude',
      sessionId: 'source-session',
      generatorAgent: 'codex',
      generatorModel: 'gpt-5'
    })

    expect(enrich).toHaveBeenCalledWith(
      expect.objectContaining({ session, agent: 'codex', model: 'gpt-5' })
    )
    expect(item.source.agent).toBe('claude')
    expect(item.source).toMatchObject({
      createdAt: '2026-09-01T09:00:00.000Z',
      modifiedAt: '2026-09-01T10:00:01.000Z'
    })
    expect(item.generator.agent).toBe('codex')
    expect(upsert).toHaveBeenCalledWith(item)
  })

  it('indexes only stale sessions and continues after a generation failure', async () => {
    const sessions = [session('one'), session('two')]
    const existing = knowledgeItem('one')
    const enrich = vi
      .fn()
      .mockRejectedValueOnce(new Error('generation failed'))
      .mockResolvedValueOnce({
        summary: 'Summary',
        topics: [],
        conclusions: [],
        entities: [],
        searchTerms: [],
        agent: 'codex',
        model: 'gpt-5'
      })
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue(sessions),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: {
        list: vi.fn().mockResolvedValue([existing]),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    })

    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))

    expect(enrich).toHaveBeenCalledTimes(1)
    expect(service.getIndexStatus()).toEqual({
      state: 'idle',
      total: 1,
      completed: 0,
      failed: 1
    })
  })

  it('resumes an interrupted checkpoint and retries its active session', async () => {
    const resumed = session('resume')
    const enrich = vi.fn().mockResolvedValue({
      summary: 'Resumed',
      topics: [],
      conclusions: [],
      entities: [],
      searchTerms: [],
      handoff: [],
      agent: 'codex',
      model: 'gpt-5'
    })
    const write = vi.fn()
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([resumed]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: { list: vi.fn().mockResolvedValue([]), upsert: vi.fn(), remove: vi.fn() },
      checkpointStore: {
        read: vi.fn().mockResolvedValue({
          version: 1,
          state: 'running',
          config: { generatorAgent: 'codex', generatorModel: 'gpt-5' },
          total: 1,
          completed: 0,
          failed: 0,
          pending: [{ executionHostId: 'local', agent: 'claude', sessionId: 'resume' }]
        }),
        write
      }
    })

    await vi.waitFor(() => expect(enrich).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', pending: [] }))
  })

  it('reindexes a legacy item whose enrichment format is stale', async () => {
    const existing = knowledgeItem('one')
    delete existing.generator.formatVersion
    const enrich = vi.fn().mockResolvedValue({
      summary: 'Updated',
      topics: [],
      conclusions: [],
      entities: [],
      searchTerms: [],
      handoff: [],
      agent: 'codex',
      model: 'gpt-5'
    })
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([session('one')]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: {
        list: vi.fn().mockResolvedValue([existing]),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    })

    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))

    expect(enrich).toHaveBeenCalledOnce()
  })

  it('does not index the internal sessions created by knowledge generation', async () => {
    const enrich = vi.fn().mockResolvedValue({
      summary: 'Summary',
      topics: [],
      conclusions: [],
      entities: [],
      searchTerms: [],
      agent: 'codex',
      model: 'gpt-5'
    })
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([
        session('real'),
        {
          ...session('internal'),
          title: 'ORCA_SYSTEM_DERIVED:knowledge-enrichment v1'
        },
        {
          ...session('legacy-internal'),
          title: 'Below is a conversation log from a Claude Code coding session. Create a summary.'
        }
      ]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: {
        list: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    })

    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))

    expect(enrich).toHaveBeenCalledTimes(1)
    expect(enrich.mock.calls[0]?.[0]).toMatchObject({ session: { sessionId: 'real' } })
  })

  it('rejects a direct regeneration request for a system-derived session', async () => {
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([
        {
          ...session('internal'),
          title: 'ORCA_SYSTEM_DERIVED:knowledge-enrichment v1'
        }
      ]),
      readSession: vi.fn(),
      enrich: vi.fn(),
      store: {
        list: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    })

    await expect(
      service.generate({
        sourceAgent: 'claude',
        sessionId: 'internal',
        generatorAgent: 'codex',
        generatorModel: 'gpt-5'
      })
    ).rejects.toThrow('System-derived conversations cannot be indexed')
  })

  it('skips zero-turn sessions and removes their cached summaries', async () => {
    const emptySession = session('empty', { messageCount: 0, previewMessages: [] })
    const remove = vi.fn().mockResolvedValue(undefined)
    const enrich = vi.fn()
    const store = {
      list: vi.fn().mockResolvedValue([knowledgeItem('empty')]),
      upsert: vi.fn().mockResolvedValue(undefined),
      remove
    }
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([emptySession]),
      readSession: vi.fn(),
      enrich,
      store
    })

    expect(await service.list()).toEqual([])
    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })

    expect(remove).toHaveBeenCalledWith(['local:claude:empty'])
    expect(enrich).not.toHaveBeenCalled()
    expect(service.getIndexStatus()).toEqual({
      state: 'idle',
      total: 0,
      completed: 0,
      failed: 0
    })
  })

  it('does not invoke an agent when the transcript has no readable messages', async () => {
    const enrich = vi.fn()
    const upsert = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockResolvedValue(undefined)
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([session('unreadable')]),
      readSession: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
      enrich,
      store: { list: vi.fn().mockResolvedValue([]), upsert, remove }
    })

    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))

    expect(enrich).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(['local:claude:unreadable'])
    expect(service.getIndexStatus()).toEqual({
      state: 'idle',
      total: 1,
      completed: 1,
      failed: 0
    })
  })

  it('reports the active session and marks unfinished work as stopped when canceled', async () => {
    let completeEnrichment!: () => void
    const enrich = vi.fn(
      () =>
        new Promise<AiVaultSessionEnrichment>((resolve) => {
          completeEnrichment = () =>
            resolve({
              summary: 'Summary',
              topics: [],
              conclusions: [],
              entities: [],
              searchTerms: [],
              handoff: [],
              agent: 'codex',
              model: 'gpt-5'
            })
        })
    )
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([session('active')]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich,
      store: {
        list: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined)
      }
    })

    await service.startIndex({ generatorAgent: 'codex', generatorModel: 'gpt-5' })
    await vi.waitFor(() =>
      expect(service.getIndexStatus().activeSession).toMatchObject({ sessionId: 'active' })
    )

    service.cancelIndex()

    expect(service.getIndexStatus()).toMatchObject({
      state: 'idle',
      completed: 0,
      failed: 0,
      canceled: 1
    })
    expect(service.getIndexStatus().activeSession).toBeUndefined()

    completeEnrichment()
    await vi.waitFor(() => expect(service.getIndexStatus().state).toBe('idle'))
    expect(service.getIndexStatus().completed).toBe(0)
  })

  it('verifies and removes legacy summaries that describe an empty transcript', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const emptyItem = {
      ...knowledgeItem('legacy-empty'),
      knowledge: {
        summary: '对话中未包含任何可读取的用户或助手消息内容。',
        topics: ['空对话'],
        conclusions: [],
        entities: []
      }
    }
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([session('legacy-empty')]),
      readSession: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
      enrich: vi.fn(),
      store: {
        list: vi.fn().mockResolvedValue([emptyItem]),
        upsert: vi.fn(),
        remove
      }
    })

    expect(await service.list()).toEqual([])
    expect(remove).toHaveBeenCalledWith(['local:claude:legacy-empty'])
  })

  it('hydrates cached knowledge with current source session timestamps', async () => {
    const currentSession = session('cached', {
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: null,
      modifiedAt: '2026-09-02T11:00:00.000Z'
    })
    const service = new ConversationKnowledgeService({
      listSessions: vi.fn().mockResolvedValue([currentSession]),
      readSession: vi.fn().mockResolvedValue(readableHistory()),
      enrich: vi.fn(),
      store: {
        list: vi.fn().mockResolvedValue([knowledgeItem('cached')]),
        upsert: vi.fn(),
        remove: vi.fn()
      }
    })

    const [item] = await service.list()

    expect(item?.source).toMatchObject({
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: null,
      modifiedAt: '2026-09-02T11:00:00.000Z'
    })
  })
})

function session(sessionId: string, overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: `claude:${sessionId}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title: sessionId,
    cwd: '/code/orca',
    branch: 'main',
    model: 'claude-sonnet-4-5',
    filePath: `/sessions/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    modifiedAt: '2026-09-01T10:00:00.000Z',
    messageCount: 2,
    totalTokens: 100,
    previewMessages: [{ role: 'user', text: 'Question', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

function readableHistory() {
  return {
    messages: [{ id: 'one', role: 'user' as const, text: 'Question', timestamp: null }],
    truncated: false
  }
}

function knowledgeItem(sessionId: string): ConversationKnowledgeItem {
  return {
    id: `local:claude:${sessionId}`,
    source: {
      executionHostId: 'local' as const,
      agent: 'claude' as const,
      sessionId,
      title: sessionId,
      cwd: '/code/orca',
      updatedAt: '2026-09-01T10:00:00.000Z'
    },
    knowledge: { summary: 'Cached', topics: [], conclusions: [], entities: [] },
    generator: {
      agent: 'codex' as const,
      model: 'gpt-5',
      generatedAt: '2026-09-01T10:01:00.000Z',
      formatVersion: CONVERSATION_KNOWLEDGE_FORMAT_VERSION
    }
  }
}
