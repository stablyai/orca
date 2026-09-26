import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readAiVaultHistorySession, searchAiVaultHistory } from './session-history'

const session: AiVaultSession = {
  id: 'local:codex:session-1:/private/session.jsonl',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Knowledge graph design',
  cwd: '/private/project',
  branch: 'main',
  model: null,
  filePath: '/private/session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
  modifiedAt: '2026-09-01T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session-1',
  subagent: null
}

const dependencies = {
  listSessions: vi.fn().mockResolvedValue({ sessions: [session], issues: [], scannedAt: 'now' }),
  readTranscript: vi.fn().mockResolvedValue({
    messages: [
      {
        id: 'm-1',
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Build a conversation knowledge graph' }],
        timestamp: 1,
        source: 'transcript' as const
      },
      {
        id: 'm-2',
        role: 'assistant' as const,
        blocks: [{ type: 'tool-call' as const, name: 'search', input: { q: 'ignored' } }],
        timestamp: 2,
        source: 'transcript' as const
      },
      {
        id: 'm-3',
        role: 'assistant' as const,
        blocks: [{ type: 'tool-result' as const, output: 'Graph source found' }],
        timestamp: 3,
        source: 'transcript' as const
      }
    ]
  })
}

describe('AI Vault session history', () => {
  it('searches complete normalized messages without disclosing transcript paths', async () => {
    const result = await searchAiVaultHistory({ query: 'graph' }, dependencies)

    expect(result).toEqual({
      scannedSessionCount: 1,
      matches: [
        {
          agent: 'codex',
          sessionId: 'session-1',
          title: 'Knowledge graph design',
          updatedAt: '2026-09-01T00:00:00.000Z',
          message: {
            id: 'm-1',
            role: 'user',
            text: 'Build a conversation knowledge graph',
            timestamp: '1970-01-01T00:00:00.001Z'
          }
        },
        {
          agent: 'codex',
          sessionId: 'session-1',
          title: 'Knowledge graph design',
          updatedAt: '2026-09-01T00:00:00.000Z',
          message: {
            id: 'm-3',
            role: 'assistant',
            text: 'Graph source found',
            timestamp: '1970-01-01T00:00:00.003Z'
          }
        }
      ]
    })
    expect(result.matches[0]).not.toHaveProperty('filePath')
    expect(dependencies.readTranscript).toHaveBeenCalledWith('codex', 'session-1', {
      filePath: '/private/session.jsonl'
    })
  })

  it('reads a bounded message window by agent and session id', async () => {
    const result = await readAiVaultHistorySession(
      { agent: 'codex', sessionId: 'session-1', limit: 1 },
      dependencies
    )

    expect(result).toEqual({
      messages: [
        {
          id: 'm-1',
          role: 'user',
          text: 'Build a conversation knowledge graph',
          timestamp: '1970-01-01T00:00:00.001Z'
        }
      ],
      truncated: true
    })
  })
})
