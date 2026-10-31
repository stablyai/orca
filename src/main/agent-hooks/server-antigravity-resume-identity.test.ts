import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { resumeRecordFromStatus } from '../../shared/agent-resume-record-from-status'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { TRANSCRIPT_MAX_SCAN_BYTES } from '../../shared/agent-hook-listener/transcript-reader'
import { AgentHookServer } from './server'
import { buildBody, PANE } from './server.test-fixtures'

// Exact origin metadata and hook shape captured from agy 1.4.11; paths/IDs are test-local.
const ROOT = '6bba92d4-47e1-440a-9571-b12bb2d474bc'
const CHILD = '2e290489-f9b1-432b-807d-f5f2acdf9421'
const ROOT_ORIGIN = {
  step_index: 0,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  content: 'Reply with OK.'
}
const CHILD_ORIGIN = {
  step_index: 0,
  source: 'SYSTEM',
  type: 'SYSTEM_MESSAGE',
  content: 'sender=0ec29085-37fc-4105-b0a9-9afb536af06c'
}
const CHILD_HOOKS = [
  { hook_event_name: 'PreInvocation', initialNumSteps: 0, invocationNum: 0 },
  { hook_event_name: 'PreToolUse', toolCall: { name: 'read_file', args: {} } },
  { hook_event_name: 'PostInvocation', invocationNum: 0 },
  { hook_event_name: 'Stop', fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' }
]

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function normalized(payload: Record<string, unknown>, state = createHookListenerState()) {
  const event = normalizeHookPayload(state, 'antigravity', buildBody(payload), 'production')
  if (!event) {
    throw new Error('Missing Antigravity event')
  }
  return event
}

function hook(transcriptPath: string, conversationId = ROOT, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreInvocation',
    conversationId,
    transcriptPath,
    lastUserInput: 'Reply with OK.',
    modelName: 'gemini-3.8-flash-high',
    ...extra
  }
}

function expectResume(server: AgentHookServer, id = ROOT) {
  const status = server.getStatusSnapshot()[0]
  if (!status) {
    throw new Error('Missing status')
  }
  expect(status).not.toHaveProperty('statusAdmissionSession')
  const record = resumeRecordFromStatus({
    entry: { ...status, updatedAt: status.receivedAt },
    worktreeId: 'wt-1',
    capturedAt: status.receivedAt
  })
  expect(record?.providerSession.id).toBe(id)
  if (!record) {
    throw new Error('Missing resume record')
  }
  expect(getAgentResumeArgv('antigravity', record.providerSession)).toEqual([
    'agy',
    '--conversation',
    id
  ])
}

it.each(CHILD_HOOKS.map((_, index) => index))(
  'keeps persisted root across cold child suffix %s',
  async (start) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-resume-'))
    const rootPath = join(dir, 'root.jsonl')
    const childPath = join(dir, 'child.jsonl')
    writeFileSync(rootPath, jsonl(ROOT_ORIGIN))
    writeFileSync(childPath, jsonl(CHILD_ORIGIN, ROOT_ORIGIN))
    let server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath: dir })
      server.ingestRemote(normalized(hook(rootPath)), 'host-1')
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      for (const suffix of CHILD_HOOKS.slice(start)) {
        const event = normalized(hook(childPath, CHILD, { lastUserInput: '', ...suffix }))
        expect(event.providerSession).toBeUndefined()
        server.ingestRemote(event, 'host-1')
        expectResume(server)
      }
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      expectResume(server)
      server.ingestRemote(normalized(hook(rootPath, 'later-root')), 'host-1')
      expectResume(server, 'later-root')
      server.ingestRemote(
        { ...normalized(hook(childPath, CHILD)), worktreeId: 'other-worktree' },
        'host-1'
      )
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
      server.ingestRemote(normalized(hook(childPath, CHILD)), 'host-2')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
      server.ingestRemote(normalized(hook(childPath, CHILD)), 'host-1')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('derives root identity from bounded first-record provenance, independently of latest input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-origin-'))
  const transcriptPath = join(dir, 'transcript.jsonl')
  const server = new AgentHookServer()
  try {
    const accepts = (first: unknown, lastUserInput?: unknown) => {
      writeFileSync(transcriptPath, jsonl(first, ROOT_ORIGIN))
      return normalized(hook(transcriptPath, ROOT, { lastUserInput }))
    }
    for (const first of [CHILD_ORIGIN, { source: 'USER', type: 'REQUEST' }, {}, null]) {
      const event = accepts(first, 'nonempty input grants no authority')
      expect(event.providerSession).toBeUndefined()
      server.ingestRemote(event, null)
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    }
    for (const lastUserInput of ['Reply with OK.', '', undefined, null]) {
      expect(accepts(ROOT_ORIGIN, lastUserInput).providerSession?.id).toBe(ROOT)
    }
    const state = createHookListenerState()
    for (const text of [
      '',
      '{"source":"USER_EXPLICIT"',
      `malformed\n${JSON.stringify(ROOT_ORIGIN)}`,
      jsonl({ ...ROOT_ORIGIN, content: 'x'.repeat(TRANSCRIPT_MAX_SCAN_BYTES) })
    ]) {
      writeFileSync(transcriptPath, text)
      expect(normalized(hook(transcriptPath), state).providerSession).toBeUndefined()
    }
    rmSync(transcriptPath)
    expect(normalized(hook(transcriptPath), state).providerSession).toBeUndefined()
    writeFileSync(transcriptPath, jsonl(ROOT_ORIGIN))
    expect(normalized(hook(dir), state).providerSession).toBeUndefined()
    const root = normalized(hook(transcriptPath), state)
    server.ingestRemote(root, null)
    expectResume(server)
    rmSync(transcriptPath)
    server.ingestRemote(
      normalized(hook(transcriptPath, ROOT, { hook_event_name: 'Stop', fullyIdle: true }), state),
      null
    )
    expectResume(server)
    server.ingestTerminalStatus({
      paneKey: PANE,
      worktreeId: 'wt-1',
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'antigravity' }
    })
    server.ingestRemote(normalized(hook(transcriptPath, CHILD)), null)
    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps warm-child dropping and helper-held completion status unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-status-'))
  const rootPath = join(dir, 'root.jsonl')
  const childPath = join(dir, 'child.jsonl')
  writeFileSync(rootPath, jsonl(ROOT_ORIGIN))
  writeFileSync(childPath, jsonl(CHILD_ORIGIN))
  const state = createHookListenerState()
  try {
    normalized(
      hook(rootPath, ROOT, {
        hook_event_name: 'PreToolUse',
        toolCall: { name: 'invoke_subagent', args: {} }
      }),
      state
    )
    expect(
      normalizeHookPayload(
        state,
        'antigravity',
        buildBody(hook(childPath, CHILD, { lastUserInput: '' })),
        'production'
      )
    ).toBeNull()
    const held = normalized(
      hook(rootPath, ROOT, { hook_event_name: 'Stop', fullyIdle: false }),
      state
    )
    expect(held.payload).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    expect(held.providerSession?.id).toBe(ROOT)
    const cold = normalized(
      hook(childPath, CHILD, { lastUserInput: '', hook_event_name: 'Stop', fullyIdle: true })
    )
    expect(cold.payload.state).toBe('done')
    expect(cold.providerSession).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
