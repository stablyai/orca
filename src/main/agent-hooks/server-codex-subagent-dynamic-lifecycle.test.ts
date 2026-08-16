import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import {
  CODEX_SUBAGENT_POLL_ACTIVE_MS,
  CODEX_SUBAGENT_POLL_QUIET_MAX_MS
} from './codex-subagent-poll-policy'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
const SECOND_CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f3170'

type AgentHookServerPollInternals = {
  codexSubagentPollTimers: Map<string, ReturnType<typeof setTimeout>>
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function activityLine(
  threadId: string,
  agentPath: string,
  kind: 'started' | 'interrupted'
): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      occurred_at_ms: 1234,
      agent_thread_id: threadId,
      agent_path: agentPath,
      kind
    }
  })
}

function spawnLine(threadId: string, agentPath: string): string {
  return activityLine(threadId, agentPath, 'started')
}

async function postCodexHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'wt-1', payload })
  })
}

describe('AgentHookServer Codex dynamic subagent lifecycle', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('keeps watching when the roster empties before another child starts', async () => {
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
      await postCodexHook(server, {
        hook_event_name: 'Stop',
        session_id: 'root-session',
        transcript_path: parentPath
      })
      expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
        expect.objectContaining({ id: CHILD_ID })
      ])

      appendFileSync(parentPath, activityLine(CHILD_ID, '/root/pr_review', 'interrupted'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
        },
        { timeout: 3_000, interval: 50 }
      )

      appendFileSync(parentPath, spawnLine(SECOND_CHILD_ID, '/root/perf_audit'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
            expect.objectContaining({ id: SECOND_CHILD_ID, description: '/root/perf_audit' })
          ])
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  it('discovers the first child after binding an initially empty parent transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postCodexHook(server, {
        hook_event_name: 'Stop',
        session_id: 'root-session',
        transcript_path: parentPath
      })
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()

      appendFileSync(parentPath, spawnLine(CHILD_ID, '/root/late_spawn'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
            expect.objectContaining({ id: CHILD_ID, description: '/root/late_spawn' })
          ])
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  it('keeps a quiet poll bounded and rearms it on the next Codex turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    const secondChildPath = join(dir, `rollout-child-${SECOND_CHILD_ID}.jsonl`)
    const started = line({ type: 'event_msg', payload: { type: 'task_started' } })
    writeFileSync(parentPath, started)
    writeFileSync(childPath, started)
    writeFileSync(secondChildPath, started)
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const internals = server as unknown as AgentHookServerPollInternals
    try {
      await postCodexHook(server, {
        hook_event_name: 'Stop',
        session_id: 'root-session',
        transcript_path: parentPath
      })
      expect(internals.codexSubagentPollTimers.has(PANE_KEY)).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000 + CODEX_SUBAGENT_POLL_QUIET_MAX_MS)
      expect(internals.codexSubagentPollTimers.has(PANE_KEY)).toBe(true)

      appendFileSync(parentPath, spawnLine(CHILD_ID, '/root/long_quiet'))
      await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_POLL_QUIET_MAX_MS)
      expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
        expect.objectContaining({ id: CHILD_ID, description: '/root/long_quiet' })
      ])

      appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_POLL_ACTIVE_MS)
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()

      await postCodexHook(server, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'root-session',
        prompt: 'continue'
      })
      expect(internals.codexSubagentPollTimers.has(PANE_KEY)).toBe(true)

      appendFileSync(parentPath, spawnLine(SECOND_CHILD_ID, '/root/rearmed'))
      await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_POLL_ACTIVE_MS)
      expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
        expect.objectContaining({ id: SECOND_CHILD_ID, description: '/root/rearmed' })
      ])
    } finally {
      server.stop()
      vi.useRealTimers()
    }
  })

  it('keeps parent discovery active across child hook lifecycle events', async () => {
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
      await postCodexHook(server, {
        hook_event_name: 'Stop',
        session_id: 'root-session',
        transcript_path: parentPath
      })
      await postCodexHook(server, {
        hook_event_name: 'PreToolUse',
        agent_id: CHILD_ID,
        agent_type: 'reviewer',
        tool_name: 'exec_command'
      })

      appendFileSync(parentPath, spawnLine(SECOND_CHILD_ID, '/root/perf_audit'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents?.map(({ id }) => id)).toEqual([
            CHILD_ID,
            SECOND_CHILD_ID
          ])
        },
        { timeout: 3_000, interval: 50 }
      )

      await postCodexHook(server, { hook_event_name: 'SubagentStop', agent_id: CHILD_ID })
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      expect(server.getStatusSnapshot()[0]?.subagents?.map(({ id }) => id)).toEqual([
        SECOND_CHILD_ID
      ])

      appendFileSync(
        secondChildPath,
        line({ type: 'event_msg', payload: { type: 'task_complete' } })
      )
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

  it('switches the watcher when the pane starts a new Codex session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-subagent-'))
    dirs.push(dir)
    const firstParentPath = join(dir, 'rollout-first-parent.jsonl')
    const nextParentPath = join(dir, 'rollout-next-parent.jsonl')
    const firstChildPath = join(dir, `rollout-first-child-${CHILD_ID}.jsonl`)
    const nextChildPath = join(dir, `rollout-next-child-${SECOND_CHILD_ID}.jsonl`)
    const started = line({ type: 'event_msg', payload: { type: 'task_started' } })
    writeFileSync(firstParentPath, started)
    writeFileSync(nextParentPath, started)
    writeFileSync(firstChildPath, started)
    writeFileSync(nextChildPath, started)
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postCodexHook(server, {
        hook_event_name: 'Stop',
        session_id: 'first-root-session',
        transcript_path: firstParentPath
      })
      await postCodexHook(server, {
        hook_event_name: 'SessionStart',
        session_id: 'next-root-session',
        transcript_path: nextParentPath
      })

      appendFileSync(firstParentPath, spawnLine(CHILD_ID, '/root/stale_child'))
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()

      appendFileSync(nextParentPath, spawnLine(SECOND_CHILD_ID, '/root/current_child'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
            expect.objectContaining({ id: SECOND_CHILD_ID, description: '/root/current_child' })
          ])
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })
})
