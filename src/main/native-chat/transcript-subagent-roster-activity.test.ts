import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fillSubagentRosterActivity } from './transcript-subagent-roster-activity'

const THREAD_ID = '01a19597-ae9a-7a90-87a1-eedc6d3a4eba'
let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('fillSubagentRosterActivity', () => {
  it('keeps a parent result and peeks one Codex line when the parent has none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-roster-activity-'))
    roots.push(root)
    const day = join(root, '2026', '10', '31')
    await mkdir(day, { recursive: true })
    const parent = join(day, 'rollout-parent.jsonl')
    const child = join(day, `rollout-2026-10-31T22-31-48-${THREAD_ID}.jsonl`)
    await writeFile(
      parent,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            kind: 'completed',
            agent_path: '/root/sample_greeting',
            agent_thread_id: THREAD_ID
          }
        }
      })}\n`
    )
    await writeFile(
      child,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: 'Hello from Orca! I am the first sample agent.'
        }
      })}\n`
    )
    const filled = await fillSubagentRosterActivity('codex', parent, [
      {
        id: '/root/sample_greeting',
        label: 'sample_greeting',
        state: 'completed',
        activity: null
      },
      {
        id: '/root/sample_checklist',
        label: 'sample_checklist',
        state: 'completed',
        activity: 'Already recorded.'
      }
    ])
    expect(filled).toEqual([
      {
        id: '/root/sample_greeting',
        label: 'sample_greeting',
        state: 'completed',
        activity: 'Hello from Orca! I am the first sample agent.'
      },
      {
        id: '/root/sample_checklist',
        label: 'sample_checklist',
        state: 'completed',
        activity: 'Already recorded.'
      }
    ])
  })
})
