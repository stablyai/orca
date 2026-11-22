import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createHookListenerState } from '../../../../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { agentWorksBehindQuestion } from '../../../../../../shared/agent-status/lifecycle/agent-works-behind-question'
import { buildRelayHookEnvelope } from '../../../../../../wsl-guest/agent-hooks/publication/agent-hook-envelope-build'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// The WSL guest normalizes each hook, then main ingests the relayed row.
function relayedPane(root: Record<string, unknown> = {}) {
  const host = createHookListenerState()
  const server = new AgentHookServer()
  const report = (payload: Record<string, unknown>) => {
    const fields = payload.agent_id ? payload : { ...root, ...payload }
    const body = buildBody({ session_id: 'session-1', turn_id: 'turn-1', ...fields })
    const event = normalizeHookPayload(host, 'codex', body, 'production')
    if (!event) {
      throw new Error('Expected a Codex status')
    }
    server.ingestRemote(buildRelayHookEnvelope(event, 'codex'), 'wsl:Ubuntu')
    return server.getStatusSnapshotForPane(PANE)[0]!
  }
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  const question = {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions: [{ title: 'SQLite or Postgres?' }] }
  }
  report({ hook_event_name: 'PreToolUse', ...question })
  expect(agentWorksBehindQuestion(report({ hook_event_name: 'PostToolUse', ...question }))).toBe(
    true
  )
  return report
}

it('relays an approval as waiting when a parallel call finishes behind a question', () => {
  const report = relayedPane()
  report({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' }
  })

  const row = report({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm lint' }
  })
  expect(row).toMatchObject({ state: 'waiting', toolInput: 'rm -rf build' })
  expect(agentWorksBehindQuestion(row)).toBe(false)
})

it('does not relay a closed question as work after the turn and its child ended', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-relayed-question-'))
  try {
    // Only a child the rollout knows outlives the root's Stop.
    const rollout = [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      {
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          agent_thread_id: 'child-1',
          agent_path: '/root/child'
        }
      }
    ]
    const transcript_path = join(directory, 'rollout.jsonl')
    writeFileSync(transcript_path, `${rollout.map((line) => JSON.stringify(line)).join('\n')}\n`)
    const report = relayedPane({ transcript_path })
    const child = { agent_id: 'child-1', tool_name: 'Bash', tool_input: { command: 'publish' } }
    report({ hook_event_name: 'PermissionRequest', ...child })
    report({ hook_event_name: 'Stop' })
    report({ hook_event_name: 'PostToolUse', ...child })

    const row = report({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    expect(row.state).toBe('done')
    expect(agentWorksBehindQuestion(row)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
