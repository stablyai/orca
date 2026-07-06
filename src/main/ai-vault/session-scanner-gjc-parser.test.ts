import { describe, expect, it } from 'vitest'
import { parseGjcSessionContent } from './session-scanner-gjc-parser'
import type { FileWithMtime } from './session-scanner-types'

const MTIME_MS = Date.parse('2026-05-01T10:12:05.000Z')
const FILE: FileWithMtime = {
  path: '/home/dev/.gjc/agent/sessions/-tmp-repo/gjc-session.jsonl',
  mtimeMs: MTIME_MS,
  modifiedAt: new Date(MTIME_MS).toISOString()
}

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('parseGjcSessionContent', () => {
  it('parses header + messages into a resumable session', async () => {
    const content = jsonl([
      {
        type: 'session',
        version: 3,
        id: 'gjc-session',
        title: 'Fix the flaky test',
        titleSource: 'user',
        timestamp: '2026-05-01T10:12:00.000Z',
        cwd: '/tmp/repo'
      },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-01T10:12:01.000Z',
        message: { role: 'user', content: 'Please fix the flaky test' }
      },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-05-01T10:12:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done — the test is stabilized.' }],
          model: 'anthropic/claude-x',
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 }
        }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('gjc')
    expect(session?.sessionId).toBe('gjc-session')
    expect(session?.cwd).toBe('/tmp/repo')
    expect(session?.title).toBe('Fix the flaky test')
    expect(session?.model).toBe('anthropic/claude-x')
    expect(session?.totalTokens).toBe(30)
    expect(session?.messageCount).toBe(2)
    expect(session?.createdAt).toBe('2026-05-01T10:12:00.000Z')
    expect(session?.previewMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(session?.previewMessages[1]?.text).toBe('Done — the test is stabilized.')
    expect(session?.resumeCommand).toBe("cd '/tmp/repo' && gjc --resume 'gjc-session'")
  })

  it('uses the auto-generated header title as a fallback, not an override target', async () => {
    const content = jsonl([
      {
        type: 'session',
        id: 'auto-title',
        title: 'Auto generated summary',
        titleSource: 'auto',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/repo'
      },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'user', content: 'the first prompt text' }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session?.title).toBe('Auto generated summary')
  })

  it('falls back to the first user prompt when the header carries no title', async () => {
    const content = jsonl([
      { type: 'session', id: 'no-title', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/tmp/repo' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'user', content: 'summarize the diff' }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session?.title).toBe('summarize the diff')
  })

  it('sums token components when totalTokens is absent', async () => {
    const content = jsonl([
      { type: 'session', id: 'tokens', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/tmp/repo' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 2 }
        }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session?.totalTokens).toBe(13)
  })

  it('captures the model from a model_change record', async () => {
    const content = jsonl([
      {
        type: 'session',
        id: 'model-change',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/repo'
      },
      {
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-05-01T10:00:01.000Z',
        model: 'minimax/minimax-m2'
      },
      {
        type: 'message',
        id: 'm1',
        parentId: 'mc1',
        timestamp: '2026-05-01T10:00:02.000Z',
        message: { role: 'user', content: 'hello' }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session?.model).toBe('minimax/minimax-m2')
  })

  it('maps developer messages to the system preview role', async () => {
    const content = jsonl([
      {
        type: 'session',
        id: 'developer-role',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/repo'
      },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'developer', content: 'injected system context' }
      }
    ])

    const session = await parseGjcSessionContent(FILE, content, 'linux')

    expect(session?.previewMessages).toEqual([
      expect.objectContaining({ role: 'system', text: 'injected system context' })
    ])
  })
})
