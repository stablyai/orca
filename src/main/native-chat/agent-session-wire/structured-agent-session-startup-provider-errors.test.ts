// The production Claude adapter, journal and start owner; the CLI frames are recorded startup results.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { claudeStreamJsonExitError } from '../../claude/claude-stream-json-exit-error'
import { ClaudeStructuredSessionAdapter } from '../../claude/structured/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/structured/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestCancelParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const MISSING: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL('../../claude/__fixtures__/claude-missing-conversation.jsonl', import.meta.url),
    'utf8'
  )
)
const MISSING_TEXT = 'No conversation found with session ID: 00000000-0000-4000-8000-00000000dead'
// The recorded zeroed startup result with another cause's text.
const GENERIC_TEXT = 'Claude could not load its managed settings'
const GENERIC = { ...MISSING, errors: [GENERIC_TEXT] }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-startup-failure-'))
  resetHostTestOperationIds()
  log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({ holdInit: true, initProof: 'none' })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { permissionMode: 'default' },
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: true,
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = startHost()
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  // A reopened chat: the queued send's start owns every attempt.
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  claude.connections.splice(0)
  host = startHost()
})

function startHost(): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${claude.connections.length}`,
    logger: log.logger,
    now: () => NOW
  })
}

afterEach(async () => {
  claude.dispose()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const eventually = <T>(assertion: () => T | Promise<T>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

async function send(text: string): Promise<string> {
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body: hostTestMessage(text) }
      })
    },
    body: hostTestMessage(text)
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** The attempt's child, once published and waiting for initialize. */
async function starting(attempt: number): Promise<FakeConnection> {
  await eventually(() => {
    expect(claude.connections).toHaveLength(attempt)
    expect(adapter['sessions'].get(SESSION)?.connection).toBe(claude.connections[attempt - 1])
  })
  return claude.connections[attempt - 1]!
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ ...message, session_id: PROVIDER_SESSION_ID })
}

/** The connection's own exit report for a child that wrote this stderr. */
function exit(connection: FakeConnection, stderr: string): void {
  connection.closed = true
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(
    claudeStreamJsonExitError(stderr, { code: 1, signal: null, processless: false })
  )
}

async function settled(clientMessageId: string) {
  await eventually(async () => {
    await host.flushStreamedEvents(SESSION)
    const { submissions } = await host.journalSnapshot(SESSION)
    const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    expect(submission?.dispatchState).toBe('rejected')
  })
  const { items } = await host.journalSnapshot(SESSION)
  return items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
}

it.each(['result', 'stderr exit', 'result then exit', 'stderr exit then result'] as const)(
  'ends a resume whose saved conversation is gone in one attempt and one Claude row (%s)',
  async (order) => {
    const handles = store.getRecord(SESSION)!.providerHandleChain
    const id = await send('continue this chat')
    const connection = await starting(1)
    if (order === 'result' || order === 'result then exit') {
      frame(connection, MISSING)
    }
    if (order === 'result') {
      // A later initialize answer cannot reopen a start Claude already refused.
      connection.initialization.resolve({})
    } else {
      exit(connection, MISSING_TEXT)
    }
    if (order === 'stderr exit then result') {
      // The exit's own refusal already carries this result's text, so it adds no row.
      frame(connection, MISSING)
    }
    const errors = await settled(id)
    expect(claude.connections).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.body).toMatchObject({
      text: "Claude couldn't find this chat's saved conversation. Start a new chat to continue.",
      failure: {
        kind: 'savedConversationMissing',
        detail: { text: expect.stringContaining(MISSING_TEXT), audience: 'log' }
      }
    })
    // The chat and its saved handle stay for the person to decide.
    expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(handles)
  }
)

// Real order: the result lands before the exit, so its own error decides the attempt.
// Claude's answer is final; only an exit with no answer retries.
it.each([
  ['result', 1, 'startFailed', "Claude couldn't start. Send your message to try again."],
  ['result then exit', 1, 'startFailed', "Claude couldn't start. Send your message to try again."],
  [
    'stderr exit',
    5,
    'providerStartFailed',
    'Claude stopped before it finished starting. Send your message to try again.'
  ]
] as const)(
  'ends a generic startup failure (%s) after %i start(s) with one row',
  async (order, starts, kind, text) => {
    const id = await send('continue this chat')
    for (let attempt = 1; attempt <= starts; attempt += 1) {
      const connection = await starting(attempt)
      if (order !== 'stderr exit') {
        frame(connection, GENERIC)
      }
      if (order === 'result then exit') {
        // Claude exits about 350 ms after its result, once the host has stopped it.
        await eventually(() => expect(connection.closeCount).toBeGreaterThan(0))
      }
      if (order !== 'result') {
        exit(connection, GENERIC_TEXT)
      }
    }
    const errors = await settled(id)
    expect(claude.connections).toHaveLength(starts)
    if (order === 'result') {
      // The host stops each failed child; the result itself is no exit evidence.
      for (const connection of claude.connections) {
        expect(connection.closeCount).toBeGreaterThan(0)
        expect(connection.exitVerdict.root).toBe('live')
      }
    }
    expect(errors).toHaveLength(1)
    expect(errors[0]?.body).toMatchObject({
      text,
      failure: { kind, detail: { text: expect.stringContaining(GENERIC_TEXT), audience: 'log' } }
    })
    if (order !== 'stderr exit') {
      // The ended start logs what Claude said.
      expect(log.entries).toContainEqual(
        expect.objectContaining({
          message: 'a provider could not finish starting',
          fields: expect.objectContaining({
            error: expect.objectContaining({ message: expect.stringContaining(GENERIC_TEXT) })
          })
        })
      )
    }
  }
)

it('leaves a Stop during startup to Stop when Claude then reports a startup failure', async () => {
  const id = await send('continue this chat')
  const connection = await starting(1)
  const stopping = host.cancel(CALLER, hostTestCancelParams())
  frame(connection, MISSING)
  expect(await stopping).toMatchObject({ ok: true })
  await eventually(async () => {
    const { submissions } = await host.journalSnapshot(SESSION)
    expect(submissions.find((entry) => entry.clientMessageId === id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
  })
  await host.flushStreamedEvents(SESSION)
  const { items } = await host.journalSnapshot(SESSION)
  expect(items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')).toEqual(
    []
  )
  expect(claude.connections).toHaveLength(1)
})

it('recovers from an unanswered startup exit with no failure row', async () => {
  await send('continue this chat')
  exit(await starting(1), GENERIC_TEXT)
  const recovered = await starting(2)
  recovered.initialization.resolve({})
  // The queued send reaches the recovered Claude.
  await eventually(() => expect(recovered.sent).toHaveLength(1))
  await host.flushStreamedEvents(SESSION)
  const { items } = await host.journalSnapshot(SESSION)
  expect(items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')).toEqual(
    []
  )
})
