import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

describe('RelayAgentHookServer Codex subagent transcript polling', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('forwards completion discovered from a child rollout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-codex-subagent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      parentPath,
      line({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          occurred_at_ms: 1234,
          agent_thread_id: CHILD_ID,
          agent_path: '/root/pr_review',
          kind: 'started'
        }
      })
    )
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            hook_event_name: 'PostToolUse',
            session_id: 'root-session',
            transcript_path: parentPath,
            tool_name: 'collaborationspawn_agent'
          }
        })
      })

      expect(response.status).toBe(204)
      expect(forward.mock.calls[0]?.[0].payload.subagents).toHaveLength(1)

      appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.waitFor(
        () => {
          expect(forward.mock.calls.at(-1)?.[0].payload.subagents).toBeUndefined()
          expect(forward).toHaveBeenCalledTimes(2)
        },
        { timeout: 2_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })
})
