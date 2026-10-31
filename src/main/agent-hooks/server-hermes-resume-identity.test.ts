import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { resumeRecordFromStatus } from '../../shared/agent-resume-record-from-status'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const ROOT = 'local-parent'
const CHILD = '20261024_child'
// Order captured from a real Hermes delegate_task run; tools/end omit platform.
const HOOKS = [
  { hook_event_name: 'on_session_start', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'pre_llm_call', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'pre_tool_call', session_id: CHILD, tool_name: 'read_file' },
  { hook_event_name: 'post_llm_call', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'on_session_end', session_id: CHILD }
]

function normalize(payload: Record<string, unknown>) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'hermes',
    buildBody(payload),
    'production'
  )
  if (!event) {
    throw new Error('Hermes hook was rejected')
  }
  return event
}

function root(id = ROOT, platform = 'cli', hook_event_name = 'pre_llm_call') {
  return normalize({ hook_event_name, session_id: id, platform, user_message: 'delegate it' })
}

function expectResume(server: AgentHookServer, id = ROOT) {
  const status = server.getStatusSnapshot()[0]
  if (!status) {
    throw new Error('Missing Hermes status')
  }
  expect(status).not.toHaveProperty('statusAdmissionSession')
  const record = resumeRecordFromStatus({
    entry: { ...status, updatedAt: status.receivedAt },
    worktreeId: 'wt-1',
    capturedAt: status.receivedAt
  })
  expect(record?.providerSession.id).toBe(id)
  if (!record) {
    throw new Error('Missing Hermes resume record')
  }
  expect(getAgentResumeArgv('hermes', record.providerSession)).toEqual(['hermes', '--resume', id])
}

it.each(HOOKS.map((_, index) => index))(
  'keeps the persisted root after restart before child hook %s',
  async (start) => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-resume-identity-'))
    let server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath: dir })
      server.ingestRemote(root(), 'host-1')
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      for (const hook of HOOKS.slice(start)) {
        const event = normalize(hook)
        expect(event.providerSession).toBeUndefined()
        server.ingestRemote(event, 'host-1')
        expectResume(server)
      }
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      expectResume(server)
      server.ingestRemote(root('selected-root', 'tui', 'on_session_reset'), 'host-1')
      expectResume(server, 'selected-root')
      server.ingestRemote(normalize(HOOKS[2]), 'host-2')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('requires root authority, never creates an unmarked tool locator, and respects host reset', () => {
  const server = new AgentHookServer()
  server.ingestRemote(normalize(HOOKS[2]), null)
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  for (const platform of ['cli', 'tui', 'desktop', 'acp']) {
    server.ingestRemote(root(platform, platform), null)
    expectResume(server, platform)
  }
  for (const platform of ['', 'subagent', 'telegram', undefined]) {
    const event = normalize({ hook_event_name: 'pre_llm_call', session_id: CHILD, platform })
    expect(event.providerSession).toBeUndefined()
    server.ingestRemote(event, null)
    expectResume(server, 'acp')
  }
  // An older normalized relay still exposes the non-authoritative event kind.
  server.ingestRemote({ ...root(CHILD), hookEventName: 'pre_tool_call' }, null)
  expectResume(server, 'acp')
  server.ingestRemote(normalize({ hook_event_name: 'on_session_end', session_id: 'acp' }), null)
  server.ingestTerminalStatus({
    paneKey: PANE,
    worktreeId: 'wt-1',
    origin: 'process',
    payload: { state: 'working', prompt: '', agentType: 'hermes' }
  })
  server.ingestRemote(normalize(HOOKS[2]), null)
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  server.stop()
})

it.each(['local', 'relay'] as const)(
  'preserves root status re-entry without tool-derived restore identity over %s',
  async (transport) => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-status-admission-'))
    const server = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (event) => {
        forwarded.push(event)
        server.ingestRemote(event, 'host-1')
      }
    })
    try {
      await server.start({ env: 'production' })
      if (transport === 'relay') {
        await relay.start()
      }
      const post = async (source: 'hermes' | 'codex', payload: Record<string, unknown>) => {
        const body = buildBody(payload)
        const response =
          transport === 'local'
            ? await postHookEvent(server, body, `/hook/${source}`)
            : await fetch(`http://127.0.0.1:${relay.getCoordinates().port}/hook/${source}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Orca-Agent-Hook-Token': relay.getCoordinates().token
                },
                body: JSON.stringify(body)
              })
        expect(response.status).toBe(204)
      }
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: ROOT, platform: 'cli' })
      await post('hermes', {
        hook_event_name: 'pre_llm_call',
        session_id: CHILD,
        platform: 'subagent'
      })
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: 'unknown-child',
        tool_name: 'read_file'
      })
      const delayedUnknown = forwarded.at(-1)
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested',
        prompt: 'review'
      })
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      if (transport === 'relay') {
        if (!delayedUnknown) {
          throw new Error('Missing relay child event')
        }
        expect(delayedUnknown.agentPresence).toEqual({ agent: 'hermes', session: 'unknown-child' })
        server.ingestRemote(delayedUnknown, 'host-1')
        expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      }
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: 'unknown-child',
        tool_name: 'read_file'
      })
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: ROOT,
        tool_name: 'delegate_task'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ agentType: 'hermes', state: 'working' })
      expectResume(server)
      // Existing warm-child status admission uses the same remembered parent, without binding its ID.
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      expect(server.getStatusSnapshot()[0]?.state).toBe('done')
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: ROOT, platform: 'cli' })
      expectResume(server)
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested',
        prompt: 'review'
      })
      // Positive authority must replace a formerly substituted child before either admission gate.
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: CHILD, platform: 'cli' })
      expectResume(server, CHILD)
      expect(JSON.stringify(forwarded)).not.toContain('statusAdmissionSession')
    } finally {
      server.stop()
      relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
