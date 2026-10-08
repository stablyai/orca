// Which turn a Claude Stop's event makes the person's cancellation, on the shipping adapter: the
// Stop ends the child, so whatever its event binds is what the child's end cut. Older CLIs end an
// interrupted turn with an error result that names no reason, and the journal's Stop rule decides
// it as it writes the end.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection,
  claudeStartupSettled
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-turn-end-'))
  resetHostTestOperationIds()
  claude = fakeClaude({ replayUuid: null })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    logger: createStructuredAgentSessionLogger(),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await claudeStartupSettled(adapter, SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields: { ...fields }
    })
  }
}

/** A send Claude takes but has not echoed yet. */
async function sendUnechoed(connection: FakeConnection, text: string): Promise<void> {
  const body = hostTestMessage(text)
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

/** Claude echoes its latest send, which opens that send's turn. */
function echoLatest(connection: FakeConnection): void {
  const written = connection.sent.findLast((message) => message.type === 'user')!
  frame(connection, { ...written, uuid: written.uuid })
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

/** Resolves once everything queued on the session's lane so far has run: a Stop's second step. */
function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

async function lastTurn() {
  await host.flushStreamedEvents(SESSION)
  const { items } = await host.journalSnapshot(SESSION)
  return readAgentJournalTurn(items.findLast((item) => item.body.kind === 'turn')?.body)
}

it("reads an older CLI's error end after a Stop pressed before the echo as interrupted, not failed", async () => {
  const connection = claude.connections[0]!
  claude.routes.interrupt = () => {
    setTimeout(() => {
      echoLatest(connection)
      frame(connection, { type: 'result', subtype: 'error_during_execution', is_error: true })
      frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }, 5)
    return { still_queued: [], cancelled: [] }
  }
  await sendUnechoed(connection, 'Write a long reply.')

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(await lastTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
})

// A phone names the turn it last saw. The Stop ends the child, which ends whatever is in flight,
// so its event names no ended turn: it binds the turn the follow-up's echo opens.
it('reads a follow-up the child end cut as interrupted when the Stop named the turn before it', async () => {
  const connection = claude.connections[0]!
  await sendUnechoed(connection, 'Write a long reply.')
  frame(connection, { type: 'system', subtype: 'init', uuid: 'init-1', capabilities: CAPABILITIES })
  echoLatest(connection)
  const ended = await eventually(async () => {
    const turnId = activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
    expect(turnId).not.toBeNull()
    return turnId!
  })
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'ended-result' })
  await eventually(async () =>
    expect(activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)).toBe(
      null
    )
  )
  await sendUnechoed(connection, 'Follow up.')
  // Claude takes the interrupt; the follow-up's echo opens its turn, which outlives the grace.
  claude.routes.interrupt = () => {
    setTimeout(() => echoLatest(connection), 5)
    return { still_queued: [], cancelled: [] }
  }

  await expect(stop(ended)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  const cut = await lastTurn()
  expect(cut?.turnId).not.toBe(ended)
  expect(cut).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
}, 15_000)

// The Stop bound only the turn it stopped: a later turn's error end is the provider's own.
it("keeps an older CLI's error end on a later turn a failure, with its error text, after a turnless Stop", async () => {
  const stopped = claude.connections[0]!
  claude.routes.interrupt = () => {
    setTimeout(() => {
      echoLatest(stopped)
      frame(stopped, { type: 'result', subtype: 'error_during_execution', is_error: true })
      frame(stopped, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }, 5)
    return { still_queued: [], cancelled: [] }
  }
  await sendUnechoed(stopped, 'Write a long reply.')
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()
  expect(await lastTurn()).toMatchObject({ outcome: 'cancellation' })

  // The next send starts a new child on the same conversation.
  const body = hostTestMessage('Carry on.')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(stopped)
    expect(started.sent.some((message) => JSON.stringify(message).includes('Carry on.'))).toBe(true)
    return started
  })
  echoLatest(resumed)
  frame(resumed, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'API Error: overloaded'
  })

  await eventually(async () =>
    expect(await lastTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
  )
  const { items } = await host.journalSnapshot(SESSION)
  expect(JSON.stringify(items.map((item) => item.body))).toContain('API Error: overloaded')
})
