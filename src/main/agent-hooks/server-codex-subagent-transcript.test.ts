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

  it('reconciles a dropped child completion after restart without inferring a parent terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-restart-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      parentPath,
      `${line({ type: 'event_msg', payload: { type: 'task_started' } })}${line({ type: 'event_msg', payload: { type: 'task_complete' } })}${line({ type: 'event_msg', payload: { type: 'task_started' } })}${spawnLine(CHILD_ID, '/root/restart_repro')}`
    )
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const post = async (server: AgentHookServer): Promise<void> => {
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
    }
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    await post(first)
    expect(first.getStatusSnapshot()[0]?.subagents).toHaveLength(1)
    first.stop()
    appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))

    const second = new AgentHookServer()
    await second.start({ env: 'production', userDataPath: dir })
    try {
      await vi.waitFor(
        () => {
          const status = second.getStatusSnapshot()[0]
          expect(status?.state).toBe('working')
          expect(status?.subagents).toBeUndefined()
          expect(status?.restoredUnconfirmed).toBe(true)
        },
        { timeout: 2_500, interval: 50 }
      )
      appendFileSync(parentPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.waitFor(() => expect(second.getStatusSnapshot()[0]?.state).toBe('done'), {
        timeout: 5_500,
        interval: 50
      })
    } finally {
      second.stop()
    }
  })

  it('keeps a restored aggregate active until a child outlives the parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-restart-active-child-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      parentPath,
      `${line({ type: 'event_msg', payload: { type: 'task_started' } })}${spawnLine(CHILD_ID, '/root/active_child')}`
    )
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    try {
      const env = first.buildPtyEnv()
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
      expect(first.getStatusSnapshot()[0]?.subagents).toHaveLength(1)
    } finally {
      first.stop()
    }
    appendFileSync(parentPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))

    const second = new AgentHookServer()
    await second.start({ env: 'production', userDataPath: dir })
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(second.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: CHILD_ID, state: 'working' })]
      })
      appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
      await vi.waitFor(() => expect(second.getStatusSnapshot()[0]?.state).toBe('done'), {
        timeout: 5_500,
        interval: 50
      })
    } finally {
      second.stop()
    }
  })

  it('reconciles a persisted child whose spawn record fell outside the transcript tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-restart-tail-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, spawnLine(CHILD_ID, '/root/restart_tail'))
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    try {
      const env = first.buildPtyEnv()
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
      expect(first.getStatusSnapshot()[0]?.subagents).toHaveLength(1)
    } finally {
      first.stop()
    }
    appendFileSync(parentPath, `${'x'.repeat(1024 * 1024 + 32)}\n`)
    appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))

    const second = new AgentHookServer()
    await second.start({ env: 'production', userDataPath: dir })
    try {
      await vi.waitFor(() => expect(second.getStatusSnapshot()[0]?.subagents).toBeUndefined(), {
        timeout: 2_500,
        interval: 50
      })
    } finally {
      second.stop()
    }
  })

  it('preserves an unreadable transcript diagnostic across ordinary hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-unreadable-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, spawnLine(CHILD_ID, '/root/missing'))
    const first = new AgentHookServer()
    const server = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    try {
      const post = async (server: AgentHookServer): Promise<void> => {
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
      }
      await post(first)
      first.stop()
      await server.start({ env: 'production', userDataPath: dir })
      await vi.waitFor(
        () =>
          expect(server.getStatusSnapshot()[0]?.reconcileDiagnostic).toEqual({
            kind: 'unverifiable',
            reason: 'transcript-unreadable',
            observedAt: expect.any(Number)
          }),
        { timeout: 7_000, interval: 100 }
      )
      await post(server)
      expect(server.getStatusSnapshot()[0]?.reconcileDiagnostic).toEqual({
        kind: 'unverifiable',
        reason: 'transcript-unreadable',
        observedAt: expect.any(Number)
      })
    } finally {
      server.stop()
      first.stop()
    }
  })

  it('keeps the final reconciled roster when marking an unresolved child unverifiable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-final-reconcile-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const completedLaterPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      parentPath,
      `${spawnLine(CHILD_ID, '/root/completes-late')}${spawnLine(SECOND_CHILD_ID, '/root/missing')}`
    )
    writeFileSync(
      completedLaterPath,
      line({ type: 'event_msg', payload: { type: 'task_started' } })
    )
    const first = new AgentHookServer()
    let server: AgentHookServer | undefined
    await first.start({ env: 'production', userDataPath: dir })
    try {
      const env = first.buildPtyEnv()
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
      first.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      setTimeout(() => {
        appendFileSync(
          completedLaterPath,
          line({ type: 'event_msg', payload: { type: 'task_complete' } })
        )
      }, 3_500).unref()
      await vi.waitFor(
        () => {
          const status = server?.getStatusSnapshot()[0]
          expect(status?.reconcileDiagnostic).toEqual({
            kind: 'unverifiable',
            reason: 'transcript-unreadable',
            observedAt: expect.any(Number)
          })
          expect(status?.subagents).toEqual([expect.objectContaining({ id: SECOND_CHILD_ID })])
        },
        { timeout: 7_000, interval: 100 }
      )
    } finally {
      server?.stop()
      first.stop()
    }
  })
})
