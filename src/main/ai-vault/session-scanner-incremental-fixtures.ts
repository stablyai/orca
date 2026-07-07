import type { AiVaultAgent } from '../../shared/ai-vault-types'

import { codexFixture } from './session-scanner-codex-fixtures'

// Line builders for the incremental-parse differential tests: each agent gets
// a seed transcript, an appended continuation, and a truncated rewrite, all in
// that agent's real on-disk JSONL record shapes.

export type IncrementalAgentFixture = {
  agent: AiVaultAgent
  fileName: string
  seedLines: string[]
  appendLines: string[]
  truncatedLines: string[]
}

export function cursorFixture(): IncrementalAgentFixture {
  const line = (role: string, text: string, at: string) =>
    JSON.stringify({ role, message: { content: text }, timestamp: at })
  return {
    agent: 'cursor',
    fileName: 'agent-transcripts-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl',
    seedLines: [
      line('user', 'cursor seed question', '2026-05-01T10:00:00.000Z'),
      line('assistant', 'cursor seed answer', '2026-05-01T10:01:00.000Z')
    ],
    appendLines: [
      line('user', 'cursor follow-up', '2026-05-01T10:02:00.000Z'),
      line('assistant', 'cursor incremental answer', '2026-05-01T10:03:00.000Z')
    ],
    truncatedLines: [line('user', 'cursor rewritten', '2026-05-01T10:00:00.000Z')]
  }
}

export function copilotFixture(): IncrementalAgentFixture {
  const line = (type: string, data: Record<string, unknown>, at: string) =>
    JSON.stringify({ type, data, timestamp: at })
  return {
    agent: 'copilot',
    fileName: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl',
    seedLines: [
      line(
        'session.start',
        { sessionId: 'copilot-session-1', startTime: '2026-05-01T10:00:00.000Z' },
        '2026-05-01T10:00:00.000Z'
      ),
      line('user.message', { content: 'copilot seed question' }, '2026-05-01T10:00:05.000Z'),
      line('assistant.message', { content: 'copilot seed answer' }, '2026-05-01T10:00:30.000Z')
    ],
    appendLines: [
      line('user.message', { content: 'copilot follow-up' }, '2026-05-01T10:05:00.000Z'),
      line(
        'assistant.message',
        { content: 'copilot incremental answer' },
        '2026-05-01T10:05:30.000Z'
      ),
      line(
        'session.shutdown',
        { currentModel: 'gpt-5.1', currentTokens: 340 },
        '2026-05-01T10:06:00.000Z'
      )
    ],
    truncatedLines: [
      line(
        'session.start',
        { sessionId: 'copilot-session-1', startTime: '2026-05-01T10:00:00.000Z' },
        '2026-05-01T10:00:00.000Z'
      )
    ]
  }
}

export function droidFixture(): IncrementalAgentFixture {
  return {
    agent: 'droid',
    fileName: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl',
    seedLines: [
      JSON.stringify({
        type: 'session_start',
        id: 'droid-session-1',
        title: 'Droid seed task',
        cwd: '/repo/app',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'message',
        role: 'user',
        text: 'droid seed question',
        timestamp: '2026-05-01T10:00:05.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'completion',
        finalText: 'droid incremental answer',
        usage: { input_tokens: 50, output_tokens: 25 },
        timestamp: '2026-05-01T10:01:00.000Z'
      })
    ],
    truncatedLines: [
      JSON.stringify({
        type: 'session_start',
        id: 'droid-session-1',
        title: 'Droid rewritten',
        timestamp: '2026-05-01T10:00:00.000Z'
      })
    ]
  }
}

export function openclawFixture(): IncrementalAgentFixture {
  return {
    agent: 'openclaw',
    fileName: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl',
    seedLines: [
      JSON.stringify({
        type: 'session',
        id: 'openclaw-session-1',
        cwd: '/repo/app',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'openclaw seed question' },
        timestamp: '2026-05-01T10:00:05.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: 'openclaw incremental answer',
          model: 'claw-1',
          usage: { input_tokens: 40, output_tokens: 20 }
        },
        timestamp: '2026-05-01T10:01:00.000Z'
      })
    ],
    truncatedLines: [
      JSON.stringify({
        type: 'session',
        id: 'openclaw-session-1',
        timestamp: '2026-05-01T10:00:00.000Z'
      })
    ]
  }
}

// Pi shares OpenClaw's message-graph format and factory, but gets its own
// fixture so the registry's 'pi' branch is exercised explicitly.
export function piFixture(): IncrementalAgentFixture {
  return {
    agent: 'pi',
    fileName: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl',
    seedLines: [
      JSON.stringify({
        type: 'session',
        id: 'pi-session-1',
        cwd: '/repo/app',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'pi seed question' },
        timestamp: '2026-05-01T10:00:05.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'model_change',
        modelId: 'pi-2',
        timestamp: '2026-05-01T10:00:30.000Z'
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: 'pi incremental answer',
          usage: { input_tokens: 30, output_tokens: 10 }
        },
        timestamp: '2026-05-01T10:01:00.000Z'
      })
    ],
    truncatedLines: [
      JSON.stringify({ type: 'session', id: 'pi-session-1', timestamp: '2026-05-01T10:00:00.000Z' })
    ]
  }
}

// OMP is a Pi fork sharing the message-graph format, but keys the model on
// `model` (not Pi's `modelId`); its own fixture exercises the registry's 'omp'
// branch and that model-key difference. (The session `title` is included for
// realism only — the parser derives the title from the first user message.)
export function ompFixture(): IncrementalAgentFixture {
  return {
    agent: 'omp',
    fileName: '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000.jsonl',
    seedLines: [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'cccccccc-dddd-4eee-8fff-000000000000',
        cwd: '/repo/app',
        title: 'OMP session title',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'model_change',
        model: 'gpt-5.4-mini',
        timestamp: '2026-05-01T10:00:01.000Z'
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'omp seed question' }] },
        timestamp: '2026-05-01T10:00:05.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'omp incremental answer' }],
          model: 'gpt-5.4-mini',
          usage: { input: 40, output: 20, totalTokens: 60 }
        },
        timestamp: '2026-05-01T10:01:00.000Z'
      })
    ],
    truncatedLines: [
      JSON.stringify({
        type: 'session',
        id: 'cccccccc-dddd-4eee-8fff-000000000000',
        timestamp: '2026-05-01T10:00:00.000Z'
      })
    ]
  }
}

export function geminiJsonlFixture(): IncrementalAgentFixture {
  return {
    agent: 'gemini',
    fileName: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl',
    seedLines: [
      JSON.stringify({
        sessionId: 'gemini-session-1',
        startTime: '2026-05-01T10:00:00.000Z',
        type: 'user',
        content: 'gemini seed question',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'gemini',
        content: 'gemini seed answer',
        model: 'gemini-3-pro',
        tokens: { input: 80, output: 30 },
        timestamp: '2026-05-01T10:00:30.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'user',
        content: 'gemini follow-up',
        timestamp: '2026-05-01T10:01:00.000Z'
      }),
      JSON.stringify({ $set: { lastUpdated: '2026-05-01T10:01:05.000Z' } })
    ],
    truncatedLines: [
      JSON.stringify({
        sessionId: 'gemini-session-1',
        type: 'user',
        content: 'gemini rewritten',
        timestamp: '2026-05-01T10:00:00.000Z'
      })
    ]
  }
}

export function allIncrementalAgentFixtures(): IncrementalAgentFixture[] {
  return [
    codexFixture(),
    cursorFixture(),
    copilotFixture(),
    droidFixture(),
    openclawFixture(),
    piFixture(),
    ompFixture(),
    geminiJsonlFixture()
  ]
}
