import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

// Codex fixture lines for the incremental-parse differential tests, split out
// of session-scanner-incremental-fixtures.ts to respect the max-lines budget.

const CODEX_SESSION_ID = '019f0000-1111-7222-8333-444444444444'

function codexLine(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

export function codexFixture(): IncrementalAgentFixture {
  return {
    agent: 'codex',
    fileName: `rollout-2026-05-01T10-00-00-${CODEX_SESSION_ID}.jsonl`,
    seedLines: [
      codexLine({
        timestamp: '2026-05-01T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: CODEX_SESSION_ID, cwd: '/repo/app', git: { branch: 'feature/vault' } }
      }),
      codexLine({
        timestamp: '2026-05-01T10:00:05.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'codex seed question' }
      }),
      codexLine({
        timestamp: '2026-05-01T10:00:10.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'codex seed answer' }
      }),
      codexLine({
        timestamp: '2026-05-01T10:00:11.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } },
          model: 'gpt-5.1-codex'
        }
      })
    ],
    appendLines: [
      codexLine({
        timestamp: '2026-05-01T10:05:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'codex follow-up' }
      }),
      codexLine({
        timestamp: '2026-05-01T10:05:20.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'codex incremental answer' }
      }),
      codexLine({
        timestamp: '2026-05-01T10:05:21.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 220, output_tokens: 90, total_tokens: 310 } }
        }
      })
    ],
    truncatedLines: [
      codexLine({
        timestamp: '2026-05-01T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: CODEX_SESSION_ID, cwd: '/repo/app' }
      }),
      codexLine({
        timestamp: '2026-05-01T10:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'rewritten only turn' }
      })
    ]
  }
}

export function codexWorkerFixtureLines(): string[] {
  return [
    codexLine({
      timestamp: '2026-05-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: CODEX_SESSION_ID, cwd: '/repo/app', thread_source: 'subagent' }
    }),
    codexLine({
      timestamp: '2026-05-01T10:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'worker turn' }
    })
  ]
}

export const CODEX_FIXTURE_SESSION_ID = CODEX_SESSION_ID
