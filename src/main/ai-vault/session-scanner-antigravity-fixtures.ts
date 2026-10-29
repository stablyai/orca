import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

export function antigravityFixture(): IncrementalAgentFixture {
  const record = (source: string, type: string, content: string, createdAt: string) =>
    JSON.stringify({ source, type, content, created_at: createdAt })
  return {
    agent: 'antigravity',
    fileName: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/.system_generated/logs/transcript.jsonl',
    seedLines: [
      record(
        'USER_EXPLICIT',
        'USER_INPUT',
        '<USER_REQUEST>antigravity seed question</USER_REQUEST>',
        '2026-05-01T10:00:00.000Z'
      ),
      record('MODEL', 'PLANNER_RESPONSE', 'antigravity seed answer', '2026-05-01T10:00:30.000Z')
    ],
    appendLines: [
      record(
        'USER',
        'REQUEST',
        '<USER_REQUEST>antigravity follow-up</USER_REQUEST>',
        '2026-05-01T10:01:00.000Z'
      )
    ],
    truncatedLines: [
      record(
        'USER_EXPLICIT',
        'USER_INPUT',
        '<USER_REQUEST>antigravity rewritten</USER_REQUEST>',
        '2026-05-01T10:00:00.000Z'
      )
    ]
  }
}
