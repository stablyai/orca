import '../../memory-agent-identity-store.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from '../../../agent-hook-server'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

const syncFs = vi.hoisted((): { recording: boolean; calls: string[] } => ({
  recording: false,
  calls: []
}))

// Record every synchronous node:fs call on a rollout, so the hook path, the directory watch, child
// reads and spool replay can prove none of them opens a live rollout on the main thread (#43539).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const [name, exported] of Object.entries(actual)) {
    const value: unknown = exported
    if (name.endsWith('Sync') && typeof value === 'function') {
      wrapped[name] = (...args: unknown[]) => {
        if (
          syncFs.recording &&
          typeof args[0] === 'string' &&
          /rollout-[^\\/]*\.jsonl$/.test(args[0])
        ) {
          syncFs.calls.push(`${name} ${args[0]}`)
        }
        return value(...args)
      }
    }
  }
  return { ...wrapped, default: wrapped }
})

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

const line = (value: unknown): string => `${JSON.stringify(value)}\n`
const event = (payload: Record<string, unknown>): string => line({ type: 'event_msg', payload })
const childHeader = line({
  type: 'session_meta',
  payload: {
    id: CHILD_ID,
    source: { subagent: { thread_spawn: { agent_path: '/root/pr_review' } } }
  }
})

/** Test setup writes rollouts too; only the server's work is recorded. */
function asTest(write: () => void): void {
  syncFs.recording = false
  write()
  syncFs.recording = true
}

describe('Codex rollouts are never read synchronously', () => {
  let dir: string

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-sync-fs-'))
    syncFs.calls.length = 0
    syncFs.recording = false
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  // Nested CLIs inherit the pane key and must not tear down the owning Codex follow-up.
  it('keeps following a child when a nested non-codex hook lands on the same pane', async () => {
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, event({ type: 'task_started', turn_id: 'turn-1' }))
    writeFileSync(childPath, childHeader + event({ type: 'task_started', turn_id: 'child-turn' }))
    const server = new AgentHookServer()
    syncFs.recording = true
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const post = (path: string, payload: unknown): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Connection: 'close',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'wt-1', payload })
        })

      await post('/hook/codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'root-session',
        turn_id: 'turn-1',
        transcript_path: parentPath
      })
      await post('/hook/codex', {
        hook_event_name: 'SubagentStart',
        session_id: 'root-session',
        transcript_path: childPath,
        agent_id: CHILD_ID
      })
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)

      const nested = await post('/hook/copilot', {
        hook_event_name: 'Stop',
        session_id: 'nested-session',
        transcript_path: join(dir, 'nested-copilot-transcript.jsonl')
      })
      expect(nested.status).toBe(204)
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)

      // The child's turn errors: Codex sends no SubagentStop, only its rollout records the end.
      asTest(() =>
        appendFileSync(
          childPath,
          event({ type: 'task_complete', turn_id: 'child-turn', error: { message: 'x' } })
        )
      )
      // waitFor runs fake time and gives real file I/O time to land between checks.
      await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined(), {
        timeout: 10_000
      })
      expect(syncFs.calls).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('finishes a replayed Codex child that completed while Orca was closed', async () => {
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, event({ type: 'task_started', turn_id: 'turn-1' }))
    writeFileSync(
      childPath,
      childHeader +
        event({ type: 'task_started', turn_id: 'child-turn' }) +
        event({ type: 'turn_aborted', turn_id: 'child-turn', reason: 'interrupted' })
    )
    const spoolDir = join(dir, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    const record = (payload: Record<string, unknown>): string =>
      JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        receivedAt: Date.now(),
        payload
      })
    writeFileSync(
      join(spoolDir, 'pane-replay.jsonl'),
      `\n${record({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'root-session',
        turn_id: 'turn-1',
        transcript_path: parentPath
      })}\n${record({
        hook_event_name: 'SubagentStart',
        session_id: 'root-session',
        transcript_path: childPath,
        agent_id: CHILD_ID
      })}\n`
    )
    const server = new AgentHookServer()
    syncFs.recording = true
    await server.start({ env: 'production', userDataPath: dir })
    try {
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1)
      // An abort settles on a read two seconds after the one that saw it (a replaced turn restarts first).
      await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined(), {
        timeout: 10_000
      })
      expect(syncFs.calls).toEqual([])
    } finally {
      server.stop()
    }
  })
})
