import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { resumeRecordFromStatus } from '../../shared/agent-resume-record-from-status'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { AgentHookServer } from './server'
import { type Body, buildBody, PANE, postHookEvent } from './server.test-fixtures'

const ROOT = 'cf0e6ff2-9ede-46de-a430-5778cf8da164'
const CHILD = 'copilot-helper'

function rootEnd(sessionKey: string = 'session_id'): Body {
  // Copilot 1.0.105 captured root SessionEnd payloads; cwd is redacted to a test folder.
  // The hook script sends the configured event name in the envelope, not the payload.
  return sessionKey === 'sessionId'
    ? buildBody(
        { sessionId: ROOT, timestamp: 1793350540748, cwd: '/test/project', reason: 'user_exit' },
        { hookEventName: 'sessionEnd' }
      )
    : buildBody(
        {
          hook_event_name: 'SessionEnd',
          session_id: ROOT,
          timestamp: '2026-10-30T08:55:40.748Z',
          cwd: '/test/project',
          reason: 'user_exit'
        },
        { hookEventName: 'SessionEnd' }
      )
}

function normalize(body: Body) {
  const event = normalizeHookPayload(createHookListenerState(), 'copilot', body, 'production')
  if (!event) {
    throw new Error('Copilot hook was rejected')
  }
  return event
}

function expectResume(server: AgentHookServer, id: string = ROOT): void {
  const status = server.getStatusSnapshot()[0]
  expect(status?.providerSession?.id).toBe(id)
  if (!status) {
    throw new Error('Missing Copilot status')
  }
  const record = resumeRecordFromStatus({
    entry: { ...status, updatedAt: status.receivedAt },
    worktreeId: 'wt-1',
    capturedAt: status.receivedAt
  })
  expect(record?.providerSession.id).toBe(id)
  if (!record) {
    throw new Error('Missing Copilot resume record')
  }
  expect(getAgentResumeArgv('copilot', record.providerSession)).toEqual([
    'copilot',
    `--resume=${id}`
  ])
}

it.each([
  ['agent_id', 'session_id'],
  ['agentId', 'sessionId'],
  ['parent_agent_id', 'session_id'],
  ['parentAgentId', 'sessionId']
])('keeps docs-shaped Copilot %s child hooks out of the pane restore ID', (marker, sessionKey) => {
  const server = new AgentHookServer()
  const root = normalize(rootEnd(sessionKey))
  expect(root.providerSession?.id).toBe(ROOT)
  server.ingestRemote(root, 'host-1')
  // The child shape is documented, not captured; its session field's owner is unspecified.
  const child = normalize(
    buildBody({
      hook_event_name: 'PreToolUse',
      [sessionKey]: CHILD,
      [marker]: marker.startsWith('parent') ? 'parent-agent' : CHILD,
      tool_name: 'ask_user',
      tool_input: { question: 'Which target?' }
    })
  )
  expect(child.providerSession).toBeUndefined()
  expect(child.payload.state).toBe('blocked')
  server.ingestRemote(child, 'host-1')
  expect(server.getStatusSnapshot()[0]?.state).toBe('blocked')
  expectResume(server)
  const end = rootEnd(sessionKey)
  const childEnd = normalize({
    ...end,
    payload: { ...end.payload, [sessionKey]: CHILD, [marker]: CHILD }
  })
  server.ingestRemote(childEnd, 'host-1')
  server.ingestRemote(child, 'host-1')
  expectResume(server)
})

it('rejects old-relay child identity before a root exists and keeps later root/owner changes authoritative', () => {
  const server = new AgentHookServer()
  // Old normalized relays may omit source but already forward toolAgentId and providerSession.
  const child = {
    paneKey: PANE,
    worktreeId: 'wt-1',
    toolAgentId: CHILD,
    providerSession: { key: 'session_id', id: CHILD },
    payload: { state: 'working', prompt: 'child work', agentType: 'copilot' }
  }
  server.ingestRemote(child, 'host-1')
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  const root = {
    ...child,
    toolAgentId: undefined,
    providerSession: { key: 'session_id', id: ROOT }
  }
  server.ingestRemote(root, 'host-1')
  server.ingestRemote({ ...child, isReplay: true }, 'host-1')
  expectResume(server)
  server.ingestRemote(
    { ...root, providerSession: { key: 'session_id', id: 'next-root' } },
    'host-1'
  )
  expectResume(server, 'next-root')
  server.ingestRemote(child, 'host-2')
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  server.ingestRemote(root, 'host-2')
  server.ingestRemote({ ...child, worktreeId: 'wt-2' }, 'host-2')
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
})

it.each(['same-launch', 'resumed-launch'])(
  'persists the parent through cold listeners and a %s token',
  async (token) => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-resume-identity-'))
    let server = new AgentHookServer()
    const post = async (body: Body, launchToken: string) => {
      expect((await postHookEvent(server, { ...body, launchToken }, '/hook/copilot')).status).toBe(
        204
      )
    }
    try {
      await server.start({ env: 'production', userDataPath: dir })
      await post(rootEnd(), 'same-launch')
      expectResume(server)
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      // Child hooks here are documented shapes, not captured.
      await post(
        buildBody({
          hook_event_name: 'PreToolUse',
          session_id: CHILD,
          agent_id: CHILD,
          tool_name: 'bash'
        }),
        token
      )
      expectResume(server)
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      expectResume(server)
      const hydrated = server.getStatusSnapshot()[0]
      // Explicit resume seeding is authoritative even when old pane launch evidence remains.
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: 'copilot',
        providerSession: { key: 'session_id', id: 'selected-root' },
        // The new launch postdates the hydrated row, so the seed replaces it.
        launchedAt: (hydrated?.receivedAt ?? 0) + 1
      })
      await post(
        buildBody({
          hook_event_name: 'PreToolUse',
          sessionId: CHILD,
          parentAgentId: 'parent-agent',
          tool_name: 'bash'
        }),
        'another-launch'
      )
      expectResume(server, 'selected-root')
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('does not undo a host new-run reset or resurrect its locator on the next child hook', () => {
  const server = new AgentHookServer()
  server.ingestRemote(normalize(rootEnd()), null)
  server.ingestTerminalStatus({
    paneKey: PANE,
    worktreeId: 'wt-1',
    origin: 'process',
    payload: { state: 'working', prompt: '', agentType: 'copilot' }
  })
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  server.ingestRemote(
    {
      paneKey: PANE,
      worktreeId: 'wt-1',
      toolAgentId: CHILD,
      providerSession: { key: 'session_id', id: CHILD },
      payload: { state: 'working', prompt: '', agentType: 'copilot' }
    },
    null
  )
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
})
