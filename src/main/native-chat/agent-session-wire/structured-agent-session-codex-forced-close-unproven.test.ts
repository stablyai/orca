// A Codex app-server Orca force-closed after a frame it could not record, whose close could not prove
// it gone, on the shipping adapter and host. The child may still be running, so the host keeps it on
// record, closing: a message sent meanwhile joins that close and is refused readably, never left in
// doubt, and the old app-server's exit ends the record as the fault it was.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionEvent
} from '../../codex/codex-structured-session-adapter'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredCodexLifecycleEvent } from '../../runtime/structured-codex-lifecycle-event'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
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
let adapter: CodexStructuredSessionAdapter
let store: AgentSessionRecordStore
let codex: ReturnType<typeof fakeCodex>
let events: CodexStructuredSessionEvent[]
const unexited: (() => void)[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-forced-close-unproven-'))
  resetHostTestOperationIds()
  events = []
  codex = fakeCodex()
  let generation = 0
  adapter = new CodexStructuredSessionAdapter({
    // As the shipping resolver: a restart resumes the thread the record names.
    resolveLaunch: async () => {
      const head = agentSessionProviderHandleChainHead(
        store.getRecord(SESSION)?.providerHandleChain ?? []
      )
      return {
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: null,
        resumeThreadId: head?.handle.nativeId ?? null
      }
    },
    // As the runtime routes them.
    onEvent: (event) => {
      events.push(event)
      const lifecycleEvent = structuredCodexLifecycleEvent(event)
      if (lifecycleEvent) {
        void host.handleAdapterEvent(lifecycleEvent)
      }
    },
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW,
    mintAcquisitionGeneration: () => `generation-${++generation}`
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  // Every app-server a test left running has exited by now.
  for (const exit of unexited.splice(0)) {
    exit()
  }
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

type CodexConnection = (typeof codex.connections)[number]

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
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

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

function hostSession() {
  return host['sessions'].get(SESSION)
}

function startedTurnWith(connection: CodexConnection, text: string): boolean {
  return connection.calls.some(
    (call) => call.method === 'turn/start' && JSON.stringify(call.params).includes(text)
  )
}

/** As the real connection: a close proves nothing until the app-server's exit is observed. */
function closesOnlyOnceExited(connection: CodexConnection): { exit: () => void } {
  let exited = false
  connection.close = async () => {
    connection.closeCount += 1
    connection.closed = true
    return exited
  }
  // As the real connection reports it: inside the close Orca began.
  const exit = (): void => {
    if (!exited) {
      exited = true
      connection.handlers.onExit?.(new Error('codex app-server exited'), { expected: true })
    }
  }
  unexited.push(exit)
  return { exit }
}

async function resumedWith(connection: CodexConnection, text: string): Promise<CodexConnection> {
  return vi.waitFor(() => {
    const next = codex.connections.at(-1)!
    expect(next).not.toBe(connection)
    expect(startedTurnWith(next, text)).toBe(true)
    return next
  })
}

const FAULT_ROW = "Orca ran into a problem, so this didn't go through. Try again."

async function faultRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'hostFault' ? [item.body.text] : []
  )
}

/** A frame the journal cannot record: Orca force-closes the app-server as an unexpected end. */
function forceCloseOnAnUnrecordableFrame(connection: CodexConnection): void {
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendItem').mockReturnValueOnce({ accepted: false, reason: 'failed' })
  connection.handlers.onUnhandledFrame?.('frame:unknown-method', { method: 'mystery/event' })
}

function turnRunning(connection: CodexConnection): Promise<void> {
  const threadId = adapter['sessions'].get(SESSION)!.threadId
  connection.handlers.onNotification?.('turn/started', { threadId, turn: { id: 'turn-1' } })
  return host.flushStreamedEvents(SESSION)
}

it('keeps an app-server Orca force-closed unproven on record, refuses the next message readably, and sends the one after its exit', async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  forceCloseOnAnUnrecordableFrame(connection)

  await vi.waitFor(() => expect(events.some((event) => event.type === 'end-unproven')).toBe(true))
  await laneDrained()
  expect(hostSession()?.child).toMatchObject({
    generation: 'generation-1',
    close: { cause: 'host-stop', reported: { failure: { kind: 'hostFault' } } }
  })

  const held = await send('Carry on.')
  await vi.waitFor(async () => expect((await submission(held))?.dispatchState).toBe('rejected'))
  expect((await submission(held))?.reason).toContain("Couldn't stop Codex from before.")
  expect(startedTurnWith(connection, 'Carry on.')).toBe(false)
  expect(codex.connections).toHaveLength(1)

  old.exit()
  await vi.waitFor(() => expect(hostSession()?.child).toBeNull())
  await send('Go on.')
  const resumed = await resumedWith(connection, 'Go on.')

  expect(startedTurnWith(connection, 'Go on.')).toBe(false)
  expect(resumed.closeCount).toBe(0)
})

it("drops an exit from an app-server that is no longer the chat's", async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  forceCloseOnAnUnrecordableFrame(connection)
  await vi.waitFor(() => expect(hostSession()?.child?.close?.reported).toBeDefined())
  old.exit()
  await vi.waitFor(() => expect(hostSession()?.child).toBeNull())
  await send('Carry on.')
  const resumed = await resumedWith(connection, 'Carry on.')
  const reports = events.filter((event) => event.type === 'ended').length

  connection.handlers.onExit?.(new Error('codex app-server exited again'), { expected: true })
  await laneDrained()

  expect(events.filter((event) => event.type === 'ended')).toHaveLength(reports)
  expect(resumed.closeCount).toBe(0)
  expect(hostSession()?.child?.generation).toBe('generation-2')
})

it.each([
  ['proven at once', false],
  ['proven only by the late exit', true]
])('tells why a turn a forced close cut short stopped, its close %s', async (_name, unproven) => {
  const connection = codex.connections[0]!
  const old = unproven ? closesOnlyOnceExited(connection) : null
  await turnRunning(connection)
  forceCloseOnAnUnrecordableFrame(connection)
  if (old) {
    await vi.waitFor(() => expect(hostSession()?.child?.close?.reported).toBeDefined())
    expect(await faultRows()).toEqual([])
    old.exit()
  }
  await vi.waitFor(() => expect(hostSession()?.child).toBeNull())

  // The same end reads the same however long its proof took.
  await vi.waitFor(async () => expect(await faultRows()).toEqual([FAULT_ROW]))
  expect(await turnRows()).toEqual([{ state: 'interrupted', outcome: undefined }])
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'exit',
    failure: { kind: 'hostFault' }
  })
})

async function turnRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'turn' ? [{ state: item.body.state, outcome: item.body.outcome }] : []
  )
}

it.each([
  ['the chat is closed', 'user-close'],
  ['Orca evicts it', 'evict']
] as const)(
  'still tells why a turn a forced close cut short stopped when %s before the late exit, as the fault alone would',
  async (_name, cause) => {
    const connection = codex.connections[0]!
    const old = closesOnlyOnceExited(connection)
    await turnRunning(connection)
    forceCloseOnAnUnrecordableFrame(connection)
    await vi.waitFor(() => expect(hostSession()?.child?.close?.reported).toBeDefined())
    const journal = hostSession()!.journal
    const stopEvents = vi.spyOn(journal, 'appendStopEvent')

    // That close cannot prove the exit either.
    await expect(host.close(SESSION, cause)).rejects.toThrow()
    old.exit()
    await vi.waitFor(() => expect(hostSession()?.child).toBeNull())

    await vi.waitFor(async () => expect(await faultRows()).toEqual([FAULT_ROW]))
    // The fault ended the turn: it reads interrupted, never the user's cancellation.
    expect(await turnRows()).toEqual([{ state: 'interrupted', outcome: undefined }])
    expect(stopEvents).not.toHaveBeenCalled()
    expect(hostSession()?.lastEndedChild).toMatchObject({ cause, failure: { kind: 'hostFault' } })
  }
)

it('closes a message accepted while a forced close was unproven when the chat close that takes it over is proven later', async () => {
  const connection = codex.connections[0]!
  closesOnlyOnceExited(connection)
  forceCloseOnAnUnrecordableFrame(connection)
  await vi.waitFor(() => expect(hostSession()?.child?.close?.reported).toBeDefined())
  const closing = hostSession()!.child!
  const faultAt = closing.close!.requestedAt

  // A message is accepted, then the chat is closed, then the exit is proven, all before the
  // message's delivery step runs.
  const held = Promise.withResolvers<void>()
  const holding = host['tasks'].serialize(SESSION, () => held.promise)
  const sent = send('Sent before the close.')
  // The close's own rejection of what is queued fails, so only where its end stands closes it.
  vi.spyOn(hostSession()!.journal, 'rejectQueuedSubmissions').mockRejectedValueOnce(
    new Error('disk full')
  )
  const closed = host.close(SESSION, 'user-close')
  const ended = host['tasks'].serialize(SESSION, () =>
    host['eventRecovery'].endExitedChildUnderSerialize(SESSION, closing, {
      expected: true,
      reason: 'codex session closed'
    })
  )
  held.resolve()
  await holding
  const message = await sent
  await expect(closed).rejects.toThrow()
  await ended

  // The end stands where the close took over, after the message, so it is closed with the chat.
  await vi.waitFor(async () =>
    expect(await submission(message)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'chatClosed' }
    })
  )
  const end = hostSession()!.lastEndedChild!
  expect(end).toMatchObject({ cause: 'user-close', failure: { kind: 'hostFault' } })
  expect(end.endedAt.sequence).toBeGreaterThan(faultAt.sequence)
  expect(codex.connections).toHaveLength(1)
  expect(startedTurnWith(connection, 'Sent before the close.')).toBe(false)
})
