import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
const SECOND_CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f3170'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function spawnLine(threadId: string, agentPath: string): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      occurred_at_ms: 1234,
      agent_thread_id: threadId,
      agent_path: agentPath,
      kind: 'started'
    }
  })
}

describe('AgentHookServer Codex subagent transcript polling', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('publishes rollout-only children and removes them after their task completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
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
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
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
      expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
        expect.objectContaining({ id: CHILD_ID, description: '/root/pr_review' })
      ])

      appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
        },
        { timeout: 2_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  // Why: the poll re-arms off the object it just stored; if that identity ever drifts it stops after the first change.
  it('keeps polling across successive roster changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    const secondChildPath = join(dir, `rollout-child-${SECOND_CHILD_ID}.jsonl`)
    const started = line({ type: 'event_msg', payload: { type: 'task_started' } })
    writeFileSync(parentPath, spawnLine(CHILD_ID, '/root/pr_review'))
    writeFileSync(childPath, started)
    writeFileSync(secondChildPath, started)
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
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
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)

      appendFileSync(parentPath, spawnLine(SECOND_CHILD_ID, '/root/perf_audit'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(2)
        },
        { timeout: 3_000, interval: 50 }
      )

      const complete = line({ type: 'event_msg', payload: { type: 'task_complete' } })
      appendFileSync(childPath, complete)
      appendFileSync(secondChildPath, complete)
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  // Why: a nested non-codex CLI inherits the pane's ORCA_PANE_KEY, so its hook must not tear down the codex poll.
  it('keeps polling when a nested non-codex hook lands on the same pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, spawnLine(CHILD_ID, '/root/pr_review'))
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const post = (path: string, payload: unknown): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'wt-1', payload })
        })

      await post('/hook/codex', {
        hook_event_name: 'PostToolUse',
        session_id: 'root-session',
        transcript_path: parentPath,
        tool_name: 'collaborationspawn_agent'
      })
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)

      const nested = await post('/hook/copilot', {
        hook_event_name: 'Stop',
        session_id: 'nested-session',
        transcript_path: join(dir, 'nested-copilot-transcript.jsonl')
      })
      expect(nested.status).toBe(204)
      // The nested completion is suppressed, so the pane is still the same live codex turn.
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)

      appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })
})
