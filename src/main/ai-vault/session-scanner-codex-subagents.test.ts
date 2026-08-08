import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listCodexSubagentSessions } from './session-scanner-codex-subagents'

const CHILD_ID = '019f0000-1111-7222-8333-444444444444'

describe('listCodexSubagentSessions', () => {
  it('lists completed child rollouts hidden from top-level session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-subagents-'))
    const day = join(root, '2026', '08', '06')
    await mkdir(day, { recursive: true })
    const startedAt = Date.UTC(2026, 7, 6, 10)
    const parentPath = join(day, 'rollout-parent.jsonl')
    const childPath = join(day, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(parentPath, [
      {
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          agent_thread_id: CHILD_ID,
          agent_path: 'Review the parser',
          occurred_at_ms: startedAt
        }
      }
    ])
    await writeLines(childPath, [
      {
        timestamp: '2026-08-06T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: CHILD_ID, cwd: '/repo', thread_source: 'subagent' }
      },
      {
        timestamp: '2026-08-06T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Inspect the parser' }
      },
      {
        timestamp: '2026-08-06T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Looks correct' }
      },
      {
        timestamp: '2026-08-06T10:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete' }
      }
    ])

    const result = await listCodexSubagentSessions({ parentFilePath: parentPath, now: startedAt })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'codex',
      sessionId: CHILD_ID,
      title: 'Review the parser',
      filePath: childPath,
      messageCount: 2,
      subagent: { status: 'completed' }
    })
  })
})

async function writeLines(filePath: string, values: unknown[]): Promise<void> {
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`)
}
