import { expect, it } from 'vitest'
import { parseRolloutSessionContent } from './session-scanner-rollout-parser'
import type { FileWithMtime } from './session-scanner-types'

function fixtureFile(fileName: string): FileWithMtime {
  return {
    path: `/fixtures/${fileName}`,
    mtimeMs: 0,
    modifiedAt: '2026-08-10T10:00:00.000Z'
  }
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

it('parses a Codex-compatible rollout through the shared fold', async () => {
  const file = fixtureFile('rollout-2026-08-10T10-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  const session = await parseRolloutSessionContent({
    agent: 'codex',
    file,
    content: jsonLines([
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: '/repo/app' }
      },
      {
        timestamp: '2026-08-10T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Shared rollout question' }
      }
    ]),
    platform: 'darwin',
    sessionHome: null
  })

  expect(session).toMatchObject({
    agent: 'codex',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/repo/app',
    title: 'Shared rollout question'
  })
})
