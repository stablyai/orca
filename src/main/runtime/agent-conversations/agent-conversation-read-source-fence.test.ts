import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { InProcessAgentIdentityClient } from '../../agent-hooks/identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../agent-hooks/identity/agent-identity-worker-client'
import { buildBody } from '../../agent-hooks/server/testing/server.test-fixtures'
import type * as HookServerModule from '../../agent-hooks/server/agent-hook-server'
import type * as TranscriptReadModule from '../orchestration/workers/transcripts/worker-transcript-read'
import type { RpcContext } from '../rpc/core'
import type { ResolvedAgentConversation } from './agent-conversation-address'

/** The real hook server and transcript reader; a read can be held after its I/O, before it returns. */
const io = vi.hoisted(() => {
  const state: {
    server: null | HookServerModule.AgentHookServer
    hold: null | { read: () => void; released: Promise<void> }
  } = { server: null, hold: null }
  return state
})
vi.mock('../../agent-hooks/server/agent-hook-server', async (load) => ({
  ...(await load<typeof HookServerModule>()),
  agentHookServer: {
    terminalAgentTranscriptSource: (
      ...args: Parameters<HookServerModule.AgentHookServer['terminalAgentTranscriptSource']>
    ) => io.server!.terminalAgentTranscriptSource(...args),
    terminalAgentPlaces: (
      ...args: Parameters<HookServerModule.AgentHookServer['terminalAgentPlaces']>
    ) => io.server!.terminalAgentPlaces(...args),
    getPublicStatusSnapshotForPane: (
      ...args: Parameters<HookServerModule.AgentHookServer['getPublicStatusSnapshotForPane']>
    ) => io.server!.getPublicStatusSnapshotForPane(...args)
  }
}))
vi.mock('../orchestration/workers/transcripts/worker-transcript-read', async (load) => {
  const actual = await load<typeof TranscriptReadModule>()
  return {
    ...actual,
    readWorkerTranscript: async (...args: Parameters<typeof actual.readWorkerTranscript>) => {
      const result = await actual.readWorkerTranscript(...args)
      const hold = io.hold
      io.hold = null
      if (hold) {
        hold.read()
        await hold.released
      }
      return result
    }
  }
})

const { AgentHookServer } = await import('../../agent-hooks/server/agent-hook-server')
const { readAgentConversation } = await import('./agent-conversation-read')

const PANE = makePaneKey('tab-0', '00000000-0000-4000-8000-000000000000')
const cleanups: (() => void)[] = []
afterEach(() => {
  io.server = null
  io.hold = null
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }

  moveStatusFile(path: string | null): void {
    this.setStatusFilePath(path)
  }
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-read-fence-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function transcript(text: string): string {
  const path = join(directory(), 'session-a.jsonl')
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      sessionId: 'session-a',
      timestamp: '2026-11-13T12:00:00.000Z',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] }
    })}\n`
  )
  return path
}

function sleeping(sessionId: string, transcriptPath: string) {
  return {
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: sessionId, transcriptPath },
    connectionId: null
  }
}

/** A dormant local Claude agent whose sleeping record names its transcript, read by its Orca ID. */
async function dormantAgent() {
  const server = new IdentityTestServer()
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: directory() })
  io.server = server
  const path = transcript('reply from store A')
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-a',
        transcript_path: path,
        prompt: 'task'
      },
      { paneKey: PANE, tabId: 'tab-0' }
    ),
    'production'
  )
  server.ingestRemote(event!, null)
  await new Promise((resolve) => setImmediate(resolve))
  const orcaSessionId = server.getStatusSnapshot()[0]!.orcaSessionId!
  server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
  const records: Record<string, ReturnType<typeof sleeping>> = { a: sleeping('session-a', path) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the runtime's sleeping records.
  const ctx = {
    runtime: { readLocalSleepingAgentSessions: () => records }
  } as unknown as RpcContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the kind and the id.
  const resolved = { kind: 'terminal', orcaSessionId } as ResolvedAgentConversation
  return {
    server,
    records,
    orcaSessionId,
    read: (request: { limit?: number } = {}) => readAgentConversation(ctx, resolved, request)
  }
}

/** Starts a read, runs `change` once its transcript I/O is done, then lets it finish. */
async function readAcross(read: () => Promise<unknown>, change: () => void): Promise<unknown> {
  let release = () => {}
  const reading = new Promise<void>((done) => {
    io.hold = { read: done, released: new Promise<void>((resolve) => (release = resolve)) }
  })
  const pending = read()
  await reading
  change()
  release()
  return pending
}

it.skipIf(process.platform === 'win32').each([
  ['the status path moves to another store', 'switch'],
  ['the status path is cleared', 'clear'],
  ['the hook server stops', 'stop'],
  ['its sleeping record names another file', 'path'],
  ["its sleeping record is another conversation's", 'record']
] as const)('delivers no transcript read when %s during it', async (_, change) => {
  const agent = await dormantAgent()
  const other = directory()
  await expect(
    readAcross(agent.read, () => {
      if (change === 'switch') {
        agent.server.moveStatusFile(join(other, 'status.json'))
      } else if (change === 'clear') {
        agent.server.moveStatusFile(null)
      } else if (change === 'stop') {
        agent.server.stop()
      } else if (change === 'path') {
        agent.records.a = sleeping('session-a', join(other, 'session-a.jsonl'))
      } else {
        agent.records.a = sleeping('session-b', join(other, 'session-b.jsonl'))
      }
    })
  ).rejects.toMatchObject({
    code: 'agent_unavailable',
    message: `Agent ${agent.orcaSessionId}'s transcript changed while Orca was reading it. Read it again.`
  })
})

it.skipIf(process.platform === 'win32')(
  'reads a turn Stop ended before its reply reached the transcript as working',
  async () => {
    const server = new IdentityTestServer()
    cleanups.unshift(() => server.stop())
    await server.start({ env: 'production', userDataPath: directory() })
    io.server = server
    const path = join(directory(), 'session-a.jsonl')
    const row = (record: Record<string, unknown>) =>
      `${JSON.stringify({ sessionId: 'session-a', timestamp: '2026-11-15T12:00:00.000Z', ...record })}\n`
    const prompt = row({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: 'return FINISHED' }] }
    })
    writeFileSync(path, prompt)
    const listener = createHookListenerState()
    const hook = async (payload: Record<string, unknown>) => {
      const event = normalizeHookPayload(
        listener,
        'claude',
        buildBody(
          { session_id: 'session-a', transcript_path: path, ...payload },
          { paneKey: PANE, tabId: 'tab-0' }
        ),
        'production'
      )
      server.ingestRemote(event!, null)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'return FINISHED' })
    await hook({
      hook_event_name: 'Stop',
      last_assistant_message: 'FINISHED',
      background_tasks: [],
      session_crons: []
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the runtime's sleeping records.
    const ctx = { runtime: { readLocalSleepingAgentSessions: () => ({}) } } as unknown as RpcContext
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the kind and the id.
    const resolved = {
      kind: 'terminal',
      orcaSessionId: server.getStatusSnapshot()[0]!.orcaSessionId!
    } as ResolvedAgentConversation
    expect(await readAgentConversation(ctx, resolved, {})).toMatchObject({
      entries: [{ kind: 'message', role: 'user', text: 'return FINISHED' }],
      state: 'working'
    })

    writeFileSync(
      path,
      prompt +
        row({
          type: 'assistant',
          uuid: 'u2',
          message: {
            id: 'm2',
            role: 'assistant',
            content: [{ type: 'text', text: 'FINISHED' }],
            stop_reason: 'end_turn'
          }
        })
    )
    expect(await readAgentConversation(ctx, resolved, {})).toMatchObject({
      entries: [
        { kind: 'message', role: 'user', text: 'return FINISHED' },
        { kind: 'message', role: 'assistant', text: 'FINISHED' }
      ],
      state: 'done'
    })
  }
)

const row = (record: unknown) => `${JSON.stringify(record)}\n`
const assistant = (uuid: string, content: unknown[], stop_reason: string) =>
  row({
    type: 'assistant',
    uuid,
    message: { id: uuid, role: 'assistant', content, stop_reason }
  })
const prompt = row({
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: [{ type: 'text', text: 'do task' }] }
})
const tool = assistant(
  'a2',
  [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'check' } }],
  'tool_use'
)
const result = row({
  type: 'user',
  uuid: 'tool-result',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'ok' }]
  }
})

it.each(['thinking end', 'Stop continuation'])(
  'omits terminal completion for a %s without its own reply',
  async (shape) => {
    const agent = await dormantAgent()
    const path = agent.records.a.providerSession.transcriptPath
    writeFileSync(
      path,
      shape === 'thinking end'
        ? prompt +
            tool +
            result +
            assistant('a3', [{ type: 'thinking', thinking: 'considering' }], 'end_turn')
        : prompt +
            assistant('a1', [{ type: 'text', text: 'draft answer' }], 'end_turn') +
            row({
              type: 'user',
              uuid: 'feedback',
              isMeta: true,
              message: {
                role: 'user',
                content: [
                  { type: 'text', text: 'Stop hook feedback:\nPlease run validation first.' }
                ]
              }
            }) +
            tool
    )
    const read = await agent.read()
    expect(read.entries.at(-1)).toMatchObject({
      role: 'assistant',
      text: '',
      tools: [{ name: 'Bash' }]
    })
    expect(read.state).toBeUndefined()
  }
)

// Real shape: a background-task notification continues a tool-using turn past the read limit.
it('reads a finished turn done when its prompt is outside the limit', async () => {
  const agent = await dormantAgent()
  writeFileSync(
    agent.records.a.providerSession.transcriptPath,
    prompt +
      assistant('a1', [{ type: 'text', text: 'Checking.' }], 'tool_use') +
      tool +
      result +
      assistant('a3', [{ type: 'text', text: 'Waiting for the gate.' }], 'end_turn') +
      row({
        type: 'user',
        uuid: 'notification',
        message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>' }
      }) +
      assistant('a4', [{ type: 'text', text: 'Still waiting on the rerun.' }], 'end_turn') +
      row({ type: 'queue-operation', operation: 'dequeue' })
  )
  const read = await agent.read({ limit: 2 })
  expect(read.entries.at(-1)).toEqual({
    kind: 'message',
    role: 'assistant',
    text: 'Still waiting on the rerun.'
  })
  expect(read.state).toBe('done')
})
