// Why: locks the codex rollout → contextUsage flow — token_count readings ride codex
// hook events onto the pane's status row, appended readings surface through the
// subagent poll's applyPaneContextUsage seam (without killing the poll), a fresh
// SessionStart rollout clears the previous session's reading, and cumulative
// totals-only snapshots never masquerade as occupancy.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function tokenCountLine(inputTokens: number, outputTokens: number): string {
  return line({
    timestamp: '2026-07-29T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens
        },
        model_context_window: 272_000
      }
    }
  })
}

function spawnLine(threadId: string): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      occurred_at_ms: 1234,
      agent_thread_id: threadId,
      agent_path: '/root/pr_review',
      kind: 'started'
    }
  })
}

describe('AgentHookServer Codex rollout context-usage ingestion', () => {
  const dirs: string[] = []
  let server: AgentHookServer | undefined

  afterEach(() => {
    server?.stop()
    server = undefined
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  async function startServer(): Promise<(payload: Record<string, unknown>) => Promise<Response>> {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return (payload) =>
      fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'wt-1', payload })
      })
  }

  it('rides hook events: the latest rollout token_count lands on the pane row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-context-'))
    dirs.push(dir)
    const rolloutPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rolloutPath, tokenCountLine(10_000, 500))
    const post = await startServer()

    await expect(
      post({
        hook_event_name: 'PostToolUse',
        session_id: 'root-session',
        transcript_path: rolloutPath,
        tool_name: 'shell'
      })
    ).resolves.toMatchObject({ status: 204 })
    expect(server?.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        agentType: 'codex',
        contextUsage: { usedTokens: 10_500, maxTokens: 272_000, providerId: 'openai' }
      })
    )

    appendFileSync(rolloutPath, tokenCountLine(64_000, 1_200))
    await post({
      hook_event_name: 'Stop',
      session_id: 'root-session',
      transcript_path: rolloutPath
    })
    expect(server?.getStatusSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: 'done',
        contextUsage: { usedTokens: 65_200, maxTokens: 272_000, providerId: 'openai' }
      })
    )
  })

  it('does not restore rollout usage while tracking is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-context-'))
    dirs.push(dir)
    const rolloutPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rolloutPath, tokenCountLine(10_000, 500))
    const post = await startServer()

    await post({
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      transcript_path: rolloutPath,
      tool_name: 'shell'
    })
    server?.setContextPressureEnabled(false)
    appendFileSync(rolloutPath, tokenCountLine(64_000, 1_200))
    await post({
      hook_event_name: 'Stop',
      session_id: 'root-session',
      transcript_path: rolloutPath
    })

    expect(server?.getStatusSnapshot()[0]?.contextUsage).toBeNull()
  })

  it('surfaces appended token_count via the subagent poll seam without ending the poll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-context-'))
    dirs.push(dir)
    const rolloutPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(rolloutPath, tokenCountLine(10_000, 500) + spawnLine(CHILD_ID))
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const post = await startServer()

    await post({
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      transcript_path: rolloutPath,
      tool_name: 'collaborationspawn_agent'
    })
    expect(server?.getStatusSnapshot()[0]?.subagents).toHaveLength(1)
    expect(server?.getStatusSnapshot()[0]?.contextUsage).toEqual({
      usedTokens: 10_500,
      maxTokens: 272_000,
      providerId: 'openai'
    })

    // No further hook events: the poll's rollout re-read must apply the new reading.
    appendFileSync(rolloutPath, tokenCountLine(31_000, 700))
    await vi.waitFor(
      () => {
        expect(server?.getStatusSnapshot()[0]?.contextUsage).toEqual({
          usedTokens: 31_700,
          maxTokens: 272_000,
          providerId: 'openai'
        })
      },
      { timeout: 3_000, interval: 50 }
    )

    // The context-only upsert replaced the cached row; polling must still retire the child.
    appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
    await vi.waitFor(
      () => {
        expect(server?.getStatusSnapshot()[0]?.subagents).toBeUndefined()
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it('clears the previous reading on SessionStart with a fresh rollout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-context-'))
    dirs.push(dir)
    const firstRollout = join(dir, 'rollout-first.jsonl')
    const freshRollout = join(dir, 'rollout-fresh.jsonl')
    writeFileSync(firstRollout, tokenCountLine(48_000, 2_000))
    writeFileSync(freshRollout, line({ type: 'turn_context', payload: { cwd: '/w' } }))
    const post = await startServer()

    await post({
      hook_event_name: 'PostToolUse',
      session_id: 'first-session',
      transcript_path: firstRollout,
      tool_name: 'shell'
    })
    expect(server?.getStatusSnapshot()[0]?.contextUsage).toEqual({
      usedTokens: 50_000,
      maxTokens: 272_000,
      providerId: 'openai'
    })

    await post({
      hook_event_name: 'SessionStart',
      session_id: 'second-session',
      transcript_path: freshRollout
    })
    expect(server?.getStatusSnapshot()[0]?.contextUsage).toBeNull()
  })

  it('reports nothing for totals-only snapshots (honest unknown, not cumulative spend)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-context-'))
    dirs.push(dir)
    const rolloutPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(
      rolloutPath,
      line({
        timestamp: '2026-07-29T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 900_000,
              cached_input_tokens: 700_000,
              output_tokens: 80_000,
              reasoning_output_tokens: 30_000,
              total_tokens: 980_000
            },
            model_context_window: 272_000
          }
        }
      })
    )
    const post = await startServer()

    await post({
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      transcript_path: rolloutPath,
      tool_name: 'shell'
    })
    const [entry] = server?.getStatusSnapshot() ?? []
    expect(entry).toEqual(expect.objectContaining({ agentType: 'codex' }))
    expect(entry?.contextUsage).toBeUndefined()
  })
})
