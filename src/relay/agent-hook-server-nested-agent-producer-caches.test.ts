import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const CLAUDE_SESSION = '0f7f6c1e-1d0b-4c4e-9a52-6f1f7b0f3a11'
const CODEX_SESSION = '019a2c4e-7b1d-7c3e-8f90-1a2b3c4d5e6f'

let dir: string
let rollout: string
let desktop: AgentHookServer
let relay: RelayAgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-nested-agent-producer-'))
  rollout = join(dir, 'rollout-codex.jsonl')
  writeFileSync(rollout, '')
  desktop = new AgentHookServer()
  const forward = vi.fn((envelope: AgentHookRelayEnvelope) =>
    desktop.ingestRemote(envelope, 'ssh-connection')
  )
  relay = new RelayAgentHookServer({ endpointDir: dir, forward })
  await relay.start()
})

afterEach(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function post(source: 'claude' | 'codex', payload: Record<string, unknown>): Promise<void> {
  const { port, token } = relay.getCoordinates()
  const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
    body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'folder-1', payload })
  })
  expect(response.status).toBe(204)
}

const claude = (event: Record<string, unknown>): Promise<void> =>
  post('claude', {
    session_id: CLAUDE_SESSION,
    transcript_path: join(dir, `${CLAUDE_SESSION}.jsonl`),
    cwd: dir,
    prompt_id: '5b0e4a43-8d2b-4e43-a8b5-3c0e7f1d9b22',
    permission_mode: 'default',
    ...event
  })

const codex = (event: Record<string, unknown>): Promise<void> =>
  post('codex', {
    session_id: CODEX_SESSION,
    turn_id: 'turn-1',
    transcript_path: rollout,
    cwd: '/remote/repo',
    model: 'gpt-6-astra',
    permission_mode: 'default',
    ...event
  })

it("keeps a relayed Claude row on Claude's prompt after a nested Codex run", async () => {
  await claude({ hook_event_name: 'UserPromptSubmit', prompt: 'claude: refactor the parser' })
  await claude({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codex exec "summarize the diff"' },
    tool_use_id: 'toolu_codex_exec'
  })
  await codex({ hook_event_name: 'SessionStart', source: 'startup' })
  await codex({ hook_event_name: 'UserPromptSubmit', prompt: 'codex: summarize the diff' })
  await codex({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok' })

  await claude({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codex exec "summarize the diff"' },
    tool_response: { stdout: 'ok', stderr: '', interrupted: false },
    tool_use_id: 'toolu_codex_exec'
  })
  expect(desktop.getStatusSnapshot()[0]).toMatchObject({
    connectionId: 'ssh-connection',
    state: 'working',
    prompt: 'claude: refactor the parser'
  })

  await claude({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'parser refactored',
    background_tasks: [],
    session_crons: []
  })
  expect(desktop.getStatusSnapshot()[0]).toMatchObject({
    connectionId: 'ssh-connection',
    state: 'done',
    prompt: 'claude: refactor the parser'
  })
})
