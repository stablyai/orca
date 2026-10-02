// A Codex app-server whose close could not prove it gone, on the shipping adapter and host: one Orca
// force-closed after a frame it could not record, and one the user's tab close stopped. The child
// may still be running, so the host keeps it and owes its stop; a message sent meanwhile waits, and
// goes out to a new app-server the moment the old one is seen to exit, with no idle-sweep tick.

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
        resumeThreadId: head?.handle.provider === 'codex' ? head.handle.threadId : null
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

async function waitRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
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
  const exit = (): void => {
    if (!exited) {
      exited = true
      connection.handlers.onExit?.(new Error('codex app-server exited'))
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

it('owes the stop of an app-server Orca force-closed unproven, holds the next message, and sends it once the old one exits', async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  // A frame the journal cannot record: Orca force-closes the app-server as an unexpected end.
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendItem').mockReturnValueOnce({ accepted: false, reason: 'failed' })
  connection.handlers.onUnhandledFrame?.('frame:unknown-method', { method: 'mystery/event' })

  await vi.waitFor(() => expect(events.some((event) => event.type === 'end-unproven')).toBe(true))
  await laneDrained()
  expect(hostSession()?.child).toMatchObject({ generation: 'generation-1' })
  expect(hostSession()?.owesProviderChildWindDown?.failedAt).toBeDefined()

  const next = await send('Carry on.')
  await vi.waitFor(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(await submission(next)).toMatchObject({ dispatchState: 'pending' })
  expect(startedTurnWith(connection, 'Carry on.')).toBe(false)
  expect(codex.connections).toHaveLength(1)

  old.exit()
  const resumed = await resumedWith(connection, 'Carry on.')

  expect(startedTurnWith(connection, 'Carry on.')).toBe(false)
  expect(resumed.closeCount).toBe(0)
  expect(hostSession()?.owesProviderChildWindDown).toBeUndefined()
})

it('sends a held message as soon as the app-server a tab close could not prove gone exits', async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  expect(hostSession()?.owesProviderChildWindDown).toMatchObject({ cause: 'user-close' })
  await send('Carry on.')
  await vi.waitFor(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  const closes = connection.closeCount
  expect(codex.connections).toHaveLength(1)

  // The requested close's own end, reported once its child exits, lands the stop it was owed.
  old.exit()
  const resumed = await resumedWith(connection, 'Carry on.')

  expect(connection.closeCount).toBe(closes + 1)
  expect(resumed.closeCount).toBe(0)
  expect(hostSession()?.owesProviderChildWindDown).toBeUndefined()
})

it("drops an exit from an app-server that is no longer the chat's", async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  await send('Carry on.')
  old.exit()
  const resumed = await resumedWith(connection, 'Carry on.')
  const reports = events.filter((event) => event.type === 'ended').length

  connection.handlers.onExit?.(new Error('codex app-server exited again'))
  await laneDrained()

  expect(events.filter((event) => event.type === 'ended')).toHaveLength(reports)
  expect(resumed.closeCount).toBe(0)
  expect(hostSession()?.child?.generation).toBe('generation-2')
})

async function faultRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'hostFault' ? [item.body.text] : []
  )
}

it.each([
  ['proven at once', false],
  ['proven only by the late exit', true]
])('tells why a turn a forced close cut short stopped, its close %s', async (_name, unproven) => {
  const connection = codex.connections[0]!
  const old = unproven ? closesOnlyOnceExited(connection) : null
  const threadId = adapter['sessions'].get(SESSION)!.threadId
  connection.handlers.onNotification?.('turn/started', { threadId, turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(SESSION)
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendItem').mockReturnValueOnce({ accepted: false, reason: 'failed' })
  connection.handlers.onUnhandledFrame?.('frame:unknown-method', { method: 'mystery/event' })
  if (old) {
    await vi.waitFor(() => expect(hostSession()?.owesProviderChildWindDown).toBeDefined())
    expect(await faultRows()).toEqual([])
    old.exit()
  }
  await vi.waitFor(() => expect(hostSession()?.child).toBeNull())
  await vi.waitFor(() => expect(hostSession()?.owesProviderChildWindDown).toBeUndefined())

  // The same end reads the same however long its proof took.
  await vi.waitFor(async () =>
    expect(await faultRows()).toEqual([
      "Orca ran into a problem, so this didn't go through. Try again."
    ])
  )
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'exit',
    failure: { kind: 'hostFault' }
  })
})

it('still tells why a turn a forced close cut short stopped when the chat is closed before the late exit', async () => {
  const connection = codex.connections[0]!
  const old = closesOnlyOnceExited(connection)
  const threadId = adapter['sessions'].get(SESSION)!.threadId
  connection.handlers.onNotification?.('turn/started', { threadId, turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(SESSION)
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendItem').mockReturnValueOnce({ accepted: false, reason: 'failed' })
  connection.handlers.onUnhandledFrame?.('frame:unknown-method', { method: 'mystery/event' })
  await vi.waitFor(() => expect(hostSession()?.owesProviderChildWindDown?.ended).toBeDefined())

  // The user closes the chat; that close cannot prove the exit either.
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  old.exit()
  await vi.waitFor(() => expect(hostSession()?.child).toBeNull())
  await vi.waitFor(() => expect(hostSession()?.owesProviderChildWindDown).toBeUndefined())

  await vi.waitFor(async () =>
    expect(await faultRows()).toEqual([
      "Orca ran into a problem, so this didn't go through. Try again."
    ])
  )
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'user-close',
    failure: { kind: 'hostFault' }
  })
})
