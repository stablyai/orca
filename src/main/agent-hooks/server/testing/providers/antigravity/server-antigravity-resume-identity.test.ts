import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../../shared/agent-hook-listener/listener-state'
import { resolveResumeLaunchRecipe } from '../../../../../../shared/agent-launch/choices/resume-launch-recipe'
import { resumeRecordFromStatus } from '../../../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { getAgentResumeArgv } from '../../../../../../shared/agent-launch/startup/agent-resume-argv'
import { TRANSCRIPT_MAX_SCAN_BYTES } from '../../../../../../shared/agent-hook-listener/transcript-reader'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, GOOD_PANE, PANE } from '../../server.test-fixtures'

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

it('records bypass permissionMode from the pane agent command line and clears it on bare or unreadable reruns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bypass-'))
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(transcriptPath, jsonl(ROOT_ORIGIN))
  let commandLine: string | null =
    '"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\agy.exe" --dangerously-skip-permissions'
  const server = new AgentHookServer()
  server.setPaneAgentCommandLineReader(async () => commandLine)
  await server.start({ env: 'production', userDataPath: dir })
  try {
    const env = server.buildPtyEnv()
    const post = async (source: 'antigravity' | 'zcode', payload: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }

    await post('antigravity', hook(transcriptPath))
    expect(server.getStatusSnapshot()[0]?.providerSession).toMatchObject({
      id: ROOT,
      permissionMode: 'bypassPermissions'
    })

    // Subagent hooks reporting their own permission_mode must not wipe the root CLI bypass.
    await post(
      'antigravity',
      hook(transcriptPath, ROOT, {
        hook_event_name: 'PreToolUse',
        agent_id: 'subagent-1',
        permission_mode: 'default'
      })
    )

    // Non-boundary hooks keep the turn's observed bypass even if process argv changes mid-turn.
    commandLine = `"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\agy.exe" --conversation ${ROOT}`
    await post(
      'antigravity',
      hook(transcriptPath, ROOT, { hook_event_name: 'Stop', fullyIdle: true })
    )
    const status = server.getStatusSnapshot()[0]
    expect(status?.providerSession?.permissionMode).toBe('bypassPermissions')
    expect(resolveResumeLaunchRecipe(undefined, 'antigravity', status?.providerSession)).toEqual({
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })

    // An unreadable/ambiguous process tree on a new turn fails closed instead of inheriting bypass.
    commandLine = null
    await post('antigravity', hook(transcriptPath))
    expect(server.getStatusSnapshot()[0]?.providerSession?.permissionMode).toBeUndefined()

    // Re-establish bypass, then verify a bare rerun clears it.
    commandLine =
      '"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\agy.exe" --dangerously-skip-permissions'
    await post('antigravity', hook(transcriptPath))
    expect(server.getStatusSnapshot()[0]?.providerSession?.permissionMode).toBe('bypassPermissions')
    commandLine = `"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\agy.exe" --conversation ${ROOT}`
    await post('antigravity', hook(transcriptPath))
    expect(server.getStatusSnapshot()[0]?.providerSession?.permissionMode).toBeUndefined()

    // Hook-reported permission_mode overrides a bare process command line.
    commandLine = 'zcode'
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/zcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify(
        buildBody(
          {
            session_id: 'zcode-session-1',
            hook_event_name: 'UserPromptSubmit',
            prompt: 'hi',
            permission_mode: 'yolo'
          },
          { paneKey: GOOD_PANE, tabId: 'tab-good' }
        )
      )
    })
    expect(response.status).toBe(204)
    expect(
      server.getStatusSnapshot().find((entry) => entry.paneKey === GOOD_PANE)?.providerSession
    ).toMatchObject({
      id: 'zcode-session-1',
      permissionMode: 'bypassPermissions'
    })
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
