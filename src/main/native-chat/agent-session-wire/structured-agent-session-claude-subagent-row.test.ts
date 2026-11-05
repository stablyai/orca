import { holdNativeJournalSql } from '../agent-session-journal/journal-native-test-instrumentation'
// Background helpers outlive spawn/turn results; unrecorded work must remain visible and resist idle eviction.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isSubagentBlock } from '../../../shared/native-chat/native-chat-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { acpChildWorkStatusSink } from '../../acp/acp-structured-child-work.test-support'
import { RESUMED_BY_MESSAGE } from '../../claude/claude-captured-task-frames.test-fixture'
import {
  result,
  says,
  type CapturedFrame
} from '../../claude/claude-captured-frame-builders.test-fixture'
import { WAKES_AFTER_ITS_SHELL } from '../../claude/claude-captured-wake-frames.test-fixture'
import { ClaudeStructuredSessionAdapter } from '../../claude/structured/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/structured/claude-structured-session-test-support'
import { claudeStartupSettled } from '../../claude/structured/claude-structured-startup-settled-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/agent-session/installation/structured-claude-runtime-adapter'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let records: ReturnType<typeof acpChildWorkStatusSink>
let clock = NOW

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-row-'))
  clock = NOW
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({ replayUuid: null })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      cliFlag: async () => 'supported' as const,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: async () => undefined,
    logger: log.logger,
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      host.publishChildWorkEvidence(sessionId, evidence, producer),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => clock
  })
  store = await openTestAgentSessionRecordStore(root)
  records = acpChildWorkStatusSink()
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: await openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    statusSink: records.sink,
    now: () => clock
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await claudeStartupSettled(adapter, SESSION)
})

afterEach(async () => {
  host.stopDelivery()
  claude.dispose()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function envelope(method: 'agentSession.send' | 'agentSession.cancel', fields: Fields) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

type Fields = Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']

async function sendAndEcho(connection: FakeConnection, text: string): Promise<void> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  expect(sent.ok).toBe(true)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, { type: 'system', subtype: 'init', uuid: 'init-1', model: 'claude-sonnet-5' })
  frame(connection, { ...connection.sent.at(-1)! })
  await host.flushStreamedEvents(SESSION)
  if (sent.ok) {
    await host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
  }
}

async function savedRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'message' ? item.body.blocks.filter(isSubagentBlock) : []
  )
}

it("keeps a background helper's row working past its spawn result and its turn's end, until its own end", async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  // Replay through spawn and parent-turn completion, before the helper ends.
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () => expect(await savedRows()).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await savedRows()).toEqual([
    expect.objectContaining({ id: 'agent-1', state: 'working', background: true })
  ])
  const { items } = await host.journalSnapshot(SESSION)
  expect(activeStructuredAgentSessionTurnId(items)).toBeNull()
  expect(items.map((item) => readAgentJournalTurn(item.body)?.state)).toContain('completed')

  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
    ({ at }) => at > 4_765 && at <= 7_427
  ).entries()) {
    frame(connection, { uuid: `run-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([
      expect.objectContaining({ id: 'agent-1', state: 'completed', tokens: 15_971 })
    ])
  )
})

it("keeps an agent whose helper the store refused past idle cleanup, until the strip's Stop", async () => {
  records.sink.publishChildWork = () => undefined
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 3_349).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  const strip = () => host['backgroundTasks'].read(SESSION)
  await eventually(() => expect(strip()).toMatchObject({ children: [], incomplete: true }))
  const stopStrip = () => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' as const }
    return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
  }

  await stopStrip()
  expect(connection.closed).toBe(false)
  expect(strip()).toMatchObject({ incomplete: true })

  frame(connection, {
    uuid: 'turn-end',
    ...RESUMED_BY_MESSAGE.find(({ at }) => at === 4_765)!.frame
  })
  await host.flushStreamedEvents(SESSION)
  clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
  await host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(connection.closed).toBe(false)
  await expect(stopStrip()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(connection.closed).toBe(true)
  await eventually(() => expect(strip()?.incomplete).toBeUndefined())
})

function capturedHelperWakes(): CapturedFrame[] {
  // The capture omits the lead's replies after each helper notification.
  const leadWake = (at: number, uuid: string): CapturedFrame[] => [
    { at, frame: says(uuid, 'Noted.', null) },
    { at: at + 1, frame: result('success') }
  ]
  return WAKES_AFTER_ITS_SHELL.flatMap((captured, index) =>
    captured.frame.subtype === 'task_notification' && captured.frame.task_id === 'agent-1'
      ? [captured, ...leadWake(captured.at + 1_000, `lead-wake-${index}`)]
      : [captured]
  )
}

it('announces a helper that outlives the turn once, after the lead answers its final result', async () => {
  const connection = claude.connections[0]!
  const completions: string[] = []
  host.subscribeTurnCompletions({
    id: 'completions',
    emit: (event) => {
      if (event.type === 'completion') {
        completions.push(event.completion.turnId)
      }
    }
  })
  await sendAndEcho(connection, 'Sleep in the background.')
  const start = clock
  const frames = capturedHelperWakes()
  for (const [index, captured] of frames.entries()) {
    clock = start + captured.at
    frame(connection, { uuid: `frame-${index}`, ...captured.frame })
    await host.flushStreamedEvents(SESSION)
  }

  // The first turn and the wake while the helper's own shell runs stay quiet; the wake its final notification opens announces.
  const finalNotification = frames.findLastIndex(
    ({ frame }) => frame.subtype === 'task_notification'
  )
  await eventually(() => expect(completions).toEqual([`frame-${finalNotification}`]))
})

it('publishes provider death before its admitted tail without announcing the preceding helper wake', async () => {
  const connection = claude.connections[0]!
  const completions: { turnId: string; outcome: string }[] = []
  host.subscribeTurnCompletions({
    id: 'exit-completions',
    emit: (event) => {
      if (event.type === 'completion') {
        completions.push({ turnId: event.completion.turnId, outcome: event.completion.outcome })
      }
    }
  })
  await sendAndEcho(connection, 'Sleep in the background.')
  const frames = capturedHelperWakes()
  const finalNotification = frames.findLastIndex(
    ({ frame }) => frame.subtype === 'task_notification'
  )
  const start = clock
  for (const [index, captured] of frames.slice(0, finalNotification).entries()) {
    clock = start + captured.at
    frame(connection, { uuid: `frame-${index}`, ...captured.frame })
    await host.flushStreamedEvents(SESSION)
  }
  const interrupted: string[] = []
  const unobserve = host.observeJournalPublications(SESSION, (journal) => {
    journal.visitItems((id) => {
      const turn = readAgentJournalTurn(journal.itemBody(id) ?? undefined)
      if (turn?.state === 'interrupted' && !interrupted.includes(turn.turnId)) {
        interrupted.push(turn.turnId)
      }
    })
  })
  const database = await openTestJournalHostDatabase(root)
  const held = await holdNativeJournalSql(
    database,
    `INSERT INTO journal_outcomes
    (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  try {
    const captured = frames[finalNotification]!
    clock = start + captured.at
    frame(connection, { uuid: `frame-${finalNotification}`, ...captured.frame })
    await held.entered
    connection.handlers.onExit?.(new Error('claude exited during its final helper wake'))
    await eventually(() => expect(host.currentWork(SESSION)?.liveFence).toBeNull())
    expect(completions).toEqual([])
  } finally {
    held.release()
  }
  await adapter.drainObservedExits()
  await host.flushAllStreamedEvents()
  await eventually(() => expect(interrupted).toEqual(['frame-16']))
  unobserve()
  // Exit supplies interruption, not a provider failure verdict or a successful old wake.
  expect(completions).toEqual([])
  expect(host.readStatusSummary(SESSION)).toMatchObject({
    status: 'idle',
    turnOutcome: 'interruption'
  })
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
})

it('keeps a helper working while its own shell runs and through its wake-up, ending on its answer', async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Sleep in the background.')
  const start = clock
  let next = 0
  const replay = async (until: number) => {
    for (; WAKES_AFTER_ITS_SHELL[next] && WAKES_AFTER_ITS_SHELL[next]!.at <= until; next++) {
      const captured = WAKES_AFTER_ITS_SHELL[next]!
      clock = start + captured.at
      frame(connection, { uuid: `wake-${next}`, ...captured.frame })
    }
    await host.flushStreamedEvents(SESSION)
  }
  const helper = async () => (await savedRows()).find(({ id }) => id === 'agent-1')
  const strip = () =>
    host['backgroundTasks'].read(SESSION)?.children?.map((child) => child.providerId) ?? []

  // CLI completion does not end the helper while its spawned shell still runs.
  await replay(11_913)
  await eventually(async () => expect(await helper()).toMatchObject({ state: 'working' }))
  expect(strip()).toEqual(['agent-1', 'shell-1'])

  // Restart the same helper run after its shell exits.
  await replay(44_460)
  await eventually(async () => expect(await helper()).toMatchObject({ state: 'working' }))
  expect(strip()).toEqual(['agent-1'])

  await replay(46_199)
  await eventually(async () =>
    expect(await helper()).toMatchObject({
      state: 'completed',
      tokens: 18_181,
      startedAt: start + 15,
      // Settled by its notification, which wakes the lead, not the update a millisecond before.
      settledAt: start + 46_199
    })
  )
  expect(strip()).toEqual([])
  expect((await savedRows()).filter(({ id }) => id === 'agent-1')).toHaveLength(1)
})

it('settles a helper still running when its session closes as unverifiable, claiming no Stop', async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'working' })])
  )
  await adapter.closeSession(SESSION)
  expect(connection.closed).toBe(true)
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  )
  expect((await savedRows())[0]).not.toHaveProperty('outcomeBasis')
})

it('keeps a helper the next child resumes while it is still starting working, past that start’s settlement', async () => {
  const first = claude.connections[0]!
  await sendAndEcho(first, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(first, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'working' })])
  )
  await adapter.closeSession(SESSION)
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  )
  // Inject helper activity before startup returns and before old-generation sweeping.
  const opened = claude.connections.push.bind(claude.connections)
  vi.spyOn(claude.connections, 'push').mockImplementation((connection) => {
    const initialize = connection.initializationResult
    let completion: Promise<unknown> | undefined
    connection.initializationResult = () =>
      (completion ??= (async () => {
        const initialized = await initialize()
        if (connection.initialization.disposed) {
          return initialized
        }
        for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
          ({ at }) => at >= 16_142 && at <= 16_143
        ).entries()) {
          frame(connection, { uuid: `resume-${index}`, ...captured.frame })
        }
        return initialized
      })())
    return opened(connection)
  })
  const body = hostTestMessage('Carry on.')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await eventually(() => expect(claude.connections).toHaveLength(2))
  await claudeStartupSettled(adapter, SESSION)
  await eventually(async () =>
    expect(await savedRows()).toEqual([
      expect.objectContaining({ id: 'agent-1', state: 'working' })
    ])
  )
})
