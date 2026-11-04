import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { ClaudeStructuredSessionAdapter } from '../../claude/structured/claude-structured-session-adapter'
import {
  claudeFrame,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/structured/claude-structured-session-test-support'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

// Recorded pane content; ordering before the user echo is a constructed protocol contract.
const FOCUS = {
  type: 'system',
  subtype: 'ui_panes',
  panes: [{ id: 'blast-radius', title: 'Blast Radius', plugin: 'blast-radius', rows: 10 }],
  shown_id: 'blast-radius',
  focused_id: null,
  focus_requested_id: 'blast-radius'
}
const CALLER = { callerKey: 'client-1' }
let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
let observedAt: number
let restoreConnections: (() => void)[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-plugin-input-'))
  resetHostTestOperationIds()
  observedAt = HOST_TEST_NOW
  restoreConnections = []
  claude = fakeClaude({ replayUuid: null })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: claude.connections.length > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    onDispatchSettledLate: (event) => void host.settleLateDispatch(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => ++observedAt
  })
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => hostTestOperationId(),
    now: () => ++observedAt
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
        providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
      })
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(child()?.phase).toBe('ready'))
})

afterEach(async () => {
  for (const restore of restoreConnections) {
    restore()
  }
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  claude.dispose()
  await rm(root, { recursive: true, force: true })
})

function child() {
  return host.collaboratorsForTests().sessions.get(SESSION)?.child
}

function envelope(method: string, fields: Record<string, unknown>, id = hostTestOperationId()) {
  return {
    sessionId: SESSION,
    clientOperationId: id,
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string, queued = false) {
  const fields = {
    body: hostTestMessage(text),
    ...(queued ? { delivery: 'queue-if-active' as const } : {})
  }
  const request = envelope('agentSession.send', fields)
  const result = await host.send(CALLER, { envelope: request, ...fields, userSend: true })
  expect(result).toMatchObject({ ok: true })
  return { id: request.clientOperationId, result }
}

async function snapshot() {
  await host.flushStreamedEvents(SESSION)
  return host.journalSnapshot(SESSION)
}

async function notices() {
  return (await snapshot()).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'pluginInputRequired'
  )
}

async function expectReply(connection: FakeConnection, text: string) {
  claudeFrame(connection, { ...connection.sent.at(-1)!, uuid: `echo-${text}` })
  claudeFrame(connection, {
    type: 'assistant',
    uuid: `reply-${text}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
  claudeFrame(connection, { type: 'result', subtype: 'success', is_error: false, result: text })
  await vi.waitFor(async () => expect(JSON.stringify((await snapshot()).items)).toContain(text))
  expect(
    (await snapshot()).items.findLast((item) => item.body.kind === 'turn')?.body
  ).toMatchObject({ state: 'completed', outcome: 'success' })
}

async function startHeld() {
  const first = claude.connections[0]!
  const initial = await send('plugin probe')
  await vi.waitFor(() => expect(first.sent).toHaveLength(1))
  return { first, initial }
}

function holdClose(first: FakeConnection) {
  const proof = Promise.withResolvers<boolean>()
  const close = first.close
  first.close = async () => {
    await close()
    return proof.promise
  }
  restoreConnections.push(() => {
    proof.resolve(true)
    first.close = close
  })
  return { proof, close }
}

it('fails an unechoed action before close proof; the quick next send joins close and gets a fresh reply', async () => {
  const { first, initial } = await startHeld()
  const { proof } = holdClose(first)
  const originalChild = child()
  claudeFrame(first, FOCUS)
  expect(child()).toBe(originalChild)
  expect(child()?.close?.failure?.kind).toBe('pluginInputRequired')
  await vi.waitFor(async () => expect(await notices()).toHaveLength(1))
  const failed = await snapshot()
  expect(failed.items.findLast((item) => item.body.kind === 'turn')?.body).toMatchObject({
    state: 'interrupted',
    outcome: 'failure'
  })
  expect(failed.submissions.find((s) => s.clientMessageId === initial.id)?.dispatchState).not.toBe(
    'accepted'
  )
  expect(host.readStatusSummary(SESSION)?.status).not.toBe('working')
  expect(host.collaboratorsForTests().sessions.get(SESSION)?.lastEndedChild).toBeUndefined()
  claudeFrame(first, { ...first.sent[0]!, uuid: 'late-failed-echo' })
  claudeFrame(first, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'late failure result'
  })
  expect(
    (await snapshot()).submissions.find((s) => s.clientMessageId === initial.id)?.dispatchState
  ).not.toBe('accepted')
  await send('fresh follow-up')
  await new Promise((resolve) => setImmediate(resolve))
  expect(claude.connections).toHaveLength(1)
  expect(first.sent).toHaveLength(1)
  proof.resolve(true)
  await vi.waitFor(() => expect(claude.connections[1]?.sent).toHaveLength(1))
  const second = claude.connections[1]!
  claudeFrame(first, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'LATE_OLD_OUTPUT' }] }
  })
  claudeFrame(first, { type: 'result', subtype: 'success', is_error: false, result: 'late result' })
  claudeFrame(first, FOCUS)
  await expectReply(second, 'FRESH_REPLY')
  expect(await notices()).toHaveLength(1)
  expect(JSON.stringify((await snapshot()).items)).not.toContain('LATE_OLD_OUTPUT')
  expect(second.closeCount).toBe(0)
  expect(first.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
})

it('retains unproven ownership, then a legitimate next-send wake retries proof and completes delivery', async () => {
  const { first } = await startHeld()
  const { proof, close } = holdClose(first)
  claudeFrame(first, FOCUS)
  await vi.waitFor(async () => expect(await notices()).toHaveLength(1))
  proof.resolve(false)
  await new Promise((resolve) => setImmediate(resolve))
  expect(child()?.close?.failure?.kind).toBe('pluginInputRequired')
  expect(claude.connections).toHaveLength(1)
  first.close = close
  await send('retry after proof failure')
  await vi.waitFor(() => expect(claude.connections[1]?.sent).toHaveLength(1))
  await expectReply(claude.connections[1]!, 'RETRY_REPLY')
  expect(first.closeCount).toBe(2)
  expect(await notices()).toHaveLength(1)
})

it('holds queued cards through semantic and physical failure until explicit Resume dispatches and replies', async () => {
  const { first } = await startHeld()
  const queued = await send('queued follow-up', true)
  expect(queued.result).toMatchObject({
    ok: true,
    value: { queued: { messageId: expect.any(String) } }
  })
  claudeFrame(first, FOCUS)
  await vi.waitFor(() => expect(child()).toBeNull())
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect(journal.queuedMessages.pauses()).toContainEqual(
    expect.objectContaining({ reason: 'failed' })
  )
  await host.flushStreamedEvents(SESSION)
  await new Promise((resolve) => setImmediate(resolve))
  expect(claude.connections).toHaveLength(1)
  expect(first.sent).toHaveLength(1)
  expect(
    await host.queuedMessagesResume(CALLER, {
      envelope: envelope('agentSession.queuedMessagesResume', {})
    })
  ).toMatchObject({ ok: true, value: { resumed: true } })
  await vi.waitFor(() => expect(claude.connections[1]?.sent).toHaveLength(1))
  await expectReply(claude.connections[1]!, 'QUEUED_REPLY')
  expect(await notices()).toHaveLength(1)
})

it.each([false, true])(
  'keeps personal Stop precedence when focus arrives during interrupt (echoed=%s)',
  async (echoed) => {
    const { first } = await startHeld()
    if (echoed) {
      claudeFrame(first, { ...first.sent[0]!, uuid: 'stopped-user-echo' })
      await vi.waitFor(async () =>
        expect(
          (await snapshot()).items.some(
            (item) => item.body.kind === 'turn' && item.body.state === 'running'
          )
        ).toBe(true)
      )
    }
    claude.routes.interrupt = () => {
      claudeFrame(first, FOCUS)
    }
    expect(
      await host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', {})
      })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(child()).toBeNull())
    expect(await notices()).toHaveLength(0)
    expect(
      (await snapshot()).items.findLast((item) => item.body.kind === 'turn')?.body
    ).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  }
)

it('finishes a retained unproven close when its exact process later reports exit', async () => {
  const { first } = await startHeld()
  const close = first.close
  restoreConnections.push(() => {
    first.close = close
  })
  first.close = async () => {
    await close()
    return false
  }
  claudeFrame(first, FOCUS)
  await vi.waitFor(async () => expect(await notices()).toHaveLength(1))
  expect(child()?.close).toBeDefined()
  first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
  first.handlers.onExit?.(new Error('late real exit'), { expected: true })
  await vi.waitFor(() => expect(child()).toBeNull())
  expect(await notices()).toHaveLength(1)
  await send('after late exit')
  await vi.waitFor(() => expect(claude.connections[1]?.sent).toHaveLength(1))
  await expectReply(claude.connections[1]!, 'LATE_EXIT_REPLY')
})
