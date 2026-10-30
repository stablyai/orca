import * as leaseRelease from './structured-agent-session-lease-release'
// All provider operations join close; proven exit ends the child record, unproven close refuses dependent work.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { claudeUnwrittenUserMessageError } from '../../claude/claude-agent-sdk-user-message-queue'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
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
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let persistHandle: ReturnType<typeof vi.fn<() => Promise<void>>>
let childWork: string[]
let now: number
let initialAttach: ReturnType<typeof hostTestAttachParams>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-exit-ends-record-'))
  resetHostTestOperationIds()
  now = NOW
  log = recordingStructuredAgentSessionLogger()
  persistHandle = vi.fn(async () => undefined)
  childWork = []
  claude = fakeClaude({
    replayUuid: null,
    routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
  })
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
      cliFlag: async () => 'supported' as const,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: () => persistHandle(),
    logger: log.logger,
    onChildWorkEvidence: (sessionId, evidence) => {
      childWork.push(...evidence.map((edge) => edge.type))
      host.publishChildWorkEvidence(sessionId, evidence)
    },
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => now
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    // Tick manually with no idle threshold to reap resting agents.
    idleSweep: { intervalMs: 3_600_000, idleMs: 0 },
    now: () => now
  })
  initialAttach = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, initialAttach)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  await Promise.all(lifecycle)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method:
    | 'agentSession.send'
    | 'agentSession.cancel'
    | 'agentSession.setOption'
    | 'agentSession.queuedMessageSend',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
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

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(`send refused: ${JSON.stringify(sent.refusal)}`)
  }
  return sent.value.clientMessageId
}

async function submission(clientMessageId: string) {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

async function openTurn(connection: FakeConnection): Promise<void> {
  const text = 'Write a long reply.'
  const clientMessageId = await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () =>
    expect((await submission(clientMessageId))?.dispatchState).toBe('accepted')
  )
  expect(
    activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  ).not.toBeNull()
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

/** Refuse writes as soon as close starts, before exit proof. */
function closeUnprovenFor(connection: FakeConnection, failures: number): void {
  const close = connection.close
  let left = failures
  connection.close = async () => {
    if (left === 0) {
      return close()
    }
    left -= 1
    connection.closeCount += 1
    connection.closed = true
    return false
  }
  refuseWritesOnceClosed(connection)
}

function refuseWritesOnceClosed(connection: FakeConnection): void {
  const write = connection.send
  connection.send = (message, beforeDispatch) =>
    connection.closed
      ? Promise.reject(
          claudeUnwrittenUserMessageError(new Error('claude stream-json connection is closed'))
        )
      : write(message, beforeDispatch)
}

const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

function child() {
  return host['sessions'].get(SESSION)?.child ?? null
}

function lease() {
  return store.getRecord(SESSION)?.lease
}

async function stopWithUnprovenClose(failures: number): Promise<FakeConnection> {
  const connection = claude.connections[0]!
  await openTurn(connection)
  closeUnprovenFor(connection, failures)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closeCount).toBe(1)
  expect(child()?.close).toMatchObject({ cause: 'user-stop' })
  return connection
}

async function resumedWith(connection: FakeConnection, text: string): Promise<FakeConnection> {
  return eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, text)).toBe(true)
    return started
  })
}

function setModel(model: string) {
  const fields = { key: 'model', value: model }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function scopes(): unknown[] {
  return log.entries.map((entry) => entry.fields.scope)
}

it('joins the close a Stop could not prove before the next message, then sends it to a resumed child', async () => {
  const connection = await stopWithUnprovenClose(1)

  await send('Carry on.')
  await resumedWith(connection, 'Carry on.')

  expect(connection.closeCount).toBe(2)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({
    cause: 'user-stop',
    rootGone: true
  })
})

it('has a second Stop join the close the first could not prove, retrying its kill', async () => {
  const connection = await stopWithUnprovenClose(1)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(connection.closeCount).toBe(2)
  expect(child()).toBeNull()
  expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({
    cause: 'user-stop',
    rootGone: true
  })
  expect(connection.calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
})

it('has a send made while the close still runs wait for that close, not start another', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const proof = deferred<void>()
  const close = connection.close
  let attempts = 0
  connection.close = async () => {
    attempts += 1
    connection.closed = true
    await proof.promise
    return close()
  }
  refuseWritesOnceClosed(connection)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  const sent = send('Carry on.')
  await eventually(() => expect(attempts).toBe(1))
  expect(claude.connections).toHaveLength(1)
  proof.resolve()
  await sent

  await resumedWith(connection, 'Carry on.')
  expect(attempts).toBe(1)
  expect(connection.closeCount).toBe(1)
})

it('ends the record at the proven exit though the resume-point write after it never settles', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  refuseWritesOnceClosed(connection)
  persistHandle.mockImplementationOnce(() => new Promise<void>(() => {}))
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  await eventually(() => expect(child()).toBeNull())
  expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({ cause: 'user-stop' })
  await send('Carry on.')
  await resumedWith(connection, 'Carry on.')
})

it('ends the record when the root exits after its close gave up, with no one asking again', async () => {
  const connection = claude.connections[0]!
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true
  })
  await stopWithUnprovenClose(1)
  childWork.length = 0

  connection.handlers.onExit?.(new Error('claude exited'), { expected: true })

  await eventually(() => expect(child()).toBeNull())
  await eventually(() => expect(lease()?.claimStatus).toBe('released'))
  expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({ cause: 'user-stop' })
  expect(connection.closeCount).toBe(2)
  expect(claude.connections).toHaveLength(1)
  await eventually(() => expect(childWork).toContain('session-ended'))
})

it('sends after a proven exit whose resume-point write and lease release both failed', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  refuseWritesOnceClosed(connection)
  persistHandle.mockRejectedValueOnce(new Error('resume point not written'))
  vi.spyOn(leaseRelease, 'releaseStoredStructuredAgentSessionOwnerAfterExit').mockRejectedValueOnce(
    new Error('store unavailable')
  )
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await eventually(() => expect(child()).toBeNull())
  await eventually(() =>
    expect(scopes()).toEqual(
      expect.arrayContaining(['claude-close-resume-point', 'exit-owner-release'])
    )
  )
  expect(lease()?.claimStatus).toBe('live')

  await send('Carry on.')
  await resumedWith(connection, 'Carry on.')
})

it('sends after a crash with a long reason whose own lease release failed', async () => {
  const connection = claude.connections[0]!
  const transition = store.transitionHandoff.bind(store)
  vi.spyOn(store, 'transitionHandoff')
    .mockImplementationOnce(async () => {
      throw new Error('store unavailable')
    })
    .mockImplementation(transition)

  connection.handlers.onExit?.(
    new Error(`claude stream-json exited (code 1): ${'stack frame\n'.repeat(700)}`)
  )
  await eventually(() => expect(child()).toBeNull())
  await eventually(() => expect(scopes()).toContain('exit-owner-release'))
  expect(lease()?.claimStatus).toBe('live')

  await send('Carry on.')
  await resumedWith(connection, 'Carry on.')
  expect(scopes()).not.toContain('ended-child-lease-release')
})

it('rejects a message whose start meets a close still unverifiable, and starts nothing beside it', async () => {
  const connection = await stopWithUnprovenClose(2)

  const next = await send('Carry on.')

  await eventually(async () => expect((await submission(next))?.dispatchState).toBe('rejected'))
  const rejected = (await submission(next))!
  expect(rejected.reason).toBe(
    "Couldn't stop Claude from before. Send your message again to try once more."
  )
  expect(rejected.rejection).toMatchObject({
    kind: 'restartFailed',
    refusal: { details: { reason: 'previousExitUnverifiable' } }
  })
  const notes = (await host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
  )
  expect(notes).toEqual([])
  expect(connection.closeCount).toBe(2)
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(child()?.close).toBeDefined()
  expect(scopes()).toContain('provider-close-unproven')
})

it('saves an option change while the close stays unverifiable without writing to the old child', async () => {
  const connection = await stopWithUnprovenClose(2)
  const calls = [...connection.calls]

  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(connection.closeCount).toBe(1)
  expect(connection.calls).toEqual(calls)

  // Keep the saved choice without touching the unverifiable child.
  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(connection.calls).toEqual(calls)
  expect(child()?.close).toBeDefined()
  expect(store.getRecord(SESSION)?.options).toMatchObject({ model: 'claude-opus-5' })
})

it('keeps an option change at rest when the Stop proved the exit and only its drain failed', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  // Stop’s read does not drain; fail only exit wind-down’s barrier.
  vi.spyOn(host['runtimeState'].eventSinkFor(SESSION), 'lifecycleBarrier').mockResolvedValueOnce({
    ok: false,
    error: new Error('drain barrier lost')
  })
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  await eventually(() => expect(child()).toBeNull())
  expect(scopes().filter((scope) => scope === 'exit-lifecycle-barrier')).toHaveLength(1)

  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.options).toMatchObject({ model: 'claude-opus-5' })
  expect(connection.closeCount).toBe(1)
  expect(claude.connections).toHaveLength(1)
})

it('reports a descendant left behind by a proven root exit, and blocks nothing', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  refuseWritesOnceClosed(connection)
  connection.close = async () => {
    connection.closeCount += 1
    connection.closed = true
    connection.exitVerdict = { root: 'exited', tree: 'live' }
    return false
  }
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  await eventually(() => expect(child()).toBeNull())
  expect(scopes()).toContain('provider-close-after-exit')
  await send('Carry on.')
  await resumedWith(connection, 'Carry on.')
})

it('has quit join a close still unverifiable, and hand the lease back once it proves', async () => {
  const connection = await stopWithUnprovenClose(1)

  await host.flushAllStreamedEvents()

  expect(connection.closeCount).toBe(2)
  expect(lease()).toMatchObject({ claimStatus: 'released', ownerProcess: null })
})

it('has the idle reaper join a close still unverifiable, ending the record with the Stop it finishes', async () => {
  const connection = await stopWithUnprovenClose(1)

  await host['lifetime'].idleSweep.tick()

  expect(connection.closeCount).toBe(2)
  expect(lease()).toMatchObject({ claimStatus: 'released', ownerProcess: null })
  expect(host.hasSession(SESSION)).toBe(false)
})

it('retains exit ownership through kept reattach and final-tail failure recovery', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const pending = await send('also held at exit')
  await eventually(() => expect(wrote(connection, 'also held at exit')).toBe(true))
  const exiting = child()!
  const originalSink = host['runtimeState'].currentEventSink(SESSION)!
  const lateEvent = deferred<void>()
  const handle = host.handleAdapterEvent.bind(host)
  vi.spyOn(host, 'handleAdapterEvent').mockImplementation((event) =>
    event.type === 'ended' ? lateEvent.promise.then(() => handle(event)) : handle(event)
  )
  const journal = host['sessions'].get(SESSION)!.journal
  const append = journal.appendResolvedItem.bind(journal)
  vi.spyOn(journal, 'appendResolvedItem').mockImplementationOnce(async (resolve, options) => {
    await append(resolve, options)
    now += 30_000
    throw new Error('final journal write acknowledgement lost')
  })
  const reserved = vi.fn()
  const continueAttach = deferred<void>()
  const reserve = store.reserveOwner.bind(store)
  vi.spyOn(store, 'reserveOwner').mockImplementationOnce(async (request) => {
    const result = await reserve(request)
    reserved()
    await continueAttach.promise
    return result
  })
  const recovery = vi.spyOn(host['eventRecovery'], 'recoverAfterSinkFailure')
  // Replayed attach reuses its operation; fresh attach cannot steal a live lease.
  const reattaching = host.attach(CALLER, initialAttach)
  try {
    await eventually(() => expect(reserved).toHaveBeenCalledOnce())
    connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    connection.handlers.onExit?.(new Error('claude exited'))
    await eventually(() => expect(recovery).toHaveBeenCalledOnce())
    expect(originalSink.state().failed).toBe(true)
    expect(adapter.heldSends(SESSION)?.size).toBe(0)
    continueAttach.resolve()
    await expect(reattaching).resolves.toMatchObject({ ok: true })
    await eventually(() => expect(child()).toBeNull())
  } finally {
    continueAttach.resolve()
    lateEvent.resolve()
  }
  expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({
    cause: 'exit',
    failure: { kind: 'hostFault' }
  })
  expect(exiting.exitObservation?.()).toMatchObject({ observedAt: NOW })
  expect(exiting.exitObservation?.().heldSends).toContain(pending)
  expect(exiting.exitObservation).toBe(originalSink.exitObservation)
  expect(claude.connections).toHaveLength(1)
  const snapshot = await host.journalSnapshot(SESSION)
  expect(snapshot.items).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ kind: 'status', failure: { kind: 'hostFault' } })
    })
  )
  expect(snapshot.items).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ kind: 'turn', state: 'interrupted', completedAt: NOW })
    })
  )
  expect(connection.closeCount).toBe(1)
})

it('delivers a message accepted after a tab close was asked for, when the late exit lands first', async () => {
  const connection = claude.connections[0]!
  closeUnprovenFor(connection, 1)
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  const closing = child()!
  expect(closing.close).toMatchObject({ cause: 'user-close' })

  // Accept before the exit report, then hold delivery until exit handling runs.
  const held = deferred<void>()
  const holding = host['tasks'].serialize(SESSION, () => held.promise)
  const sent = send('Carry on.')
  const ended = host['tasks'].serialize(SESSION, () =>
    host['eventRecovery'].endExitedChildUnderSerialize(SESSION, closing, {
      expected: true,
      reason: 'claude session closed'
    })
  )
  held.resolve()
  await holding
  const next = await sent
  await ended

  // The message postdates close, so that close cannot settle it.
  await resumedWith(connection, 'Carry on.')
  expect(await submission(next)).not.toMatchObject({ dispatchState: 'rejected' })
})

it('fails only the message its own refusal is about, never one accepted while that start was refused', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  // Fail Stop/first join proof, then let the second join prove exit.
  const close = connection.close
  const joined = deferred<boolean>()
  let attempts = 0
  connection.close = async () => {
    attempts += 1
    connection.closeCount += 1
    connection.closed = true
    if (attempts === 1) {
      return false
    }
    return attempts === 2 ? joined.promise : close()
  }
  refuseWritesOnceClosed(connection)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  const first = await send('First.')
  await eventually(() => expect(attempts).toBe(2))
  const second = send('Second.')
  joined.resolve(false)

  const secondId = await second
  await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
  await resumedWith(connection, 'Second.')
  expect(await submission(secondId)).not.toMatchObject({ dispatchState: 'rejected' })
})

it('runs the stop again for every ask after a close that came back unproven', async () => {
  const connection = await stopWithUnprovenClose(3)

  await send('First.')
  await eventually(() => expect(connection.closeCount).toBe(2))
  await laneDrained()
  await send('Second.')
  await eventually(() => expect(connection.closeCount).toBe(3))
  await laneDrained()

  await send('Third.')
  await resumedWith(connection, 'Third.')
  expect(connection.closeCount).toBe(4)
})

it('keeps model selection at rest after delivered Stop and resumes on the next send', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  vi.spyOn(connection, 'close').mockImplementation(async () => {
    connection.closed = true
    connection.exitVerdict = { root: 'live', tree: 'unverifiable', killDelivered: true }
    return true
  })
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await laneDrained()
  expect(child()).toBeNull()
  expect(await setModel('claude-opus-5')).toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.options?.model).toBe('claude-opus-5')
  expect(claude.connections).toHaveLength(1)
  await send('Continue after the kill.')
  await resumedWith(connection, 'Continue after the kill.')
})

it.each([true, false])(
  'journal failure retains its fault when kill delivery is %s',
  async (delivered) => {
    const connection = claude.connections[0]!
    await openTurn(connection)
    connection.exitVerdict = {
      root: 'live',
      tree: 'unverifiable',
      ...(delivered ? { killDelivered: true } : {})
    }
    vi.spyOn(connection, 'close').mockImplementation(async () => {
      connection.closed = true
      return delivered
    })
    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('journal unavailable'))
    await laneDrained()
    if (!delivered) {
      expect(child()?.close?.failure).toEqual({ kind: 'hostFault' })
      connection.exitVerdict = { root: 'exited', tree: 'exited' }
      connection.handlers.onExit?.(new Error('late exit after failed journal'), { expected: true })
      await eventually(() => expect(child()).toBeNull())
    } else {
      expect(child()).toBeNull()
      expect(lease()?.deathEvidence?.kind).toBe('kill-delivered')
    }
    expect(host['sessions'].get(SESSION)?.lastEndedChild?.failure).toEqual({ kind: 'hostFault' })
    const snapshot = await host.journalSnapshot(SESSION)
    expect(activeStructuredAgentSessionTurnId(snapshot.items)).toBeNull()
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'status', failure: { kind: 'hostFault' } })
      })
    )
  }
)

it.each(['idle', 'tab-close', 'sleep'] as const)(
  'retires delivered/no-report writer through the %s consumer and delivers after reopen',
  async (entry) => {
    const connection = claude.connections[0]!
    const old = child()!
    vi.spyOn(connection, 'close').mockImplementation(async () => {
      connection.closed = true
      connection.exitVerdict = { root: 'live', tree: 'unverifiable', killDelivered: true }
      return true
    })
    const before = await host.journalSnapshot(SESSION)
    if (entry === 'idle') {
      await host['lifetime'].idleSweep.tick()
    } else if (entry === 'tab-close') {
      await host.close(SESSION, 'user-close')
    } else {
      const result = await host.sleepWorkspace('workspace-1')
      expect(JSON.stringify(result)).toContain(SESSION)
    }
    await laneDrained()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(lease()).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'kill-delivered', ownerFence: old.fence }
    })
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok).toBe(true)
    expect((await host.journalSnapshot(SESSION)).items).toEqual(
      expect.arrayContaining(before.items)
    )
    await send(`Continue after ${entry}.`)
    await resumedWith(connection, `Continue after ${entry}.`)
    expect(claude.connections).toHaveLength(2)
  }
)
