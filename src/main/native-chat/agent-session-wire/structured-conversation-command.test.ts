import { listStructuredProviderSessionOwnership } from './structured-provider-session-ownership'
import { findConflictingStructuredAdoption } from '../structured-agent-session-history-adoption'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const caller = { callerKey: 'desktop' }
let directory: string
let generation: number
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let hosts: StructuredAgentSessionHost[]
let adapter: StructuredAgentSessionAdapter
const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let acquisitions = 0

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

function commandParams(command: AgentSessionConversationCommand) {
  return { command, envelope: envelope('agentSession.conversationCommand', { command }) }
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return { body, envelope: envelope('agentSession.send', { body }) }
}

const generationRoot = () => join(directory, `generation-${generation}`)

let ownerProbe: AgentSessionOwnerProbe = { outcome: 'pid-absent' }

async function openHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(generationRoot())
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(generationRoot()),
    claimKeyId: 'key',
    now: () => clock,
    mintSpawnToken: () => `spawn-${acquisitions}`,
    // The owners a restarted host finds died with the process that started them, unless a test says otherwise.
    probeOwner: async () => ownerProbe
  })
  hosts.push(host)
}

/** A crash and relaunch: the next host opens what the dying one had written, and nothing after. */
async function restartHost(): Promise<void> {
  await store.renewLeases([])
  const dying = generationRoot()
  generation++
  await cp(dying, generationRoot(), {
    recursive: true,
    filter: (source) => !source.endsWith('.tmp') && !source.includes('.lock')
  })
  await openHost()
}

beforeEach(async () => {
  resetHostTestOperationIds()
  ownerProbe = { outcome: 'pid-absent' }
  acquisitions = 0
  generation = 0
  clock = HOST_TEST_NOW
  hosts = []
  compact.mockReset().mockResolvedValue({ state: 'accepted', providerIdentity: null })
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-command-'))
  adapter = {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          // A start with no thread to resume creates one, whatever its fence.
          origin:
            input.fence > 1 && input.identity.providerHandle
              ? ('resumed' as const)
              : ('created' as const),
          handle: codexProviderHandle(
            input.identity.providerHandle?.nativeId ??
              `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          )
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    compact,
    releaseAcquisition: vi.fn(async () => true),
    closeSession: vi.fn(async () => true),
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
  await openHost()
  expect(
    await host.attach(caller, hostTestAttachParams(null, { options: { effort: 'low' } }))
  ).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
})

afterEach(async () => {
  for (const each of hosts) {
    await each.flushAllStreamedEvents()
  }
  await rm(directory, { recursive: true, force: true })
})

const journal = () => host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
const clearRows = async () =>
  (await host.journalSnapshot(HOST_TEST_SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.contextClear
  )

async function clearCommits(params = commandParams('clear'), who = caller) {
  const result = await host.conversationCommand(who, params)
  expect(result).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
  if (!result.ok) {
    throw new Error('clear refused')
  }
  expect(result.value.replacementSessionId).toBeUndefined()
  expect(result.fence).toBe(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
  return result
}

describe('same-conversation clear', () => {
  it('keeps the record, journal, tab, options and earlier messages while starting nothing', async () => {
    const source = store.getRecord(HOST_TEST_SESSION)!
    const tab = store.getSessionTabId(HOST_TEST_SESSION)
    await journal().appendItem(
      { provider: 'orca', clientMessageId: 'earlier' },
      hostTestMessage('earlier'),
      {
        fence: source.lease.runtimeFence,
        turnScope: { kind: 'thread' }
      }
    )
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    const done = await clearCommits()
    const after = await host.journalSnapshot(HOST_TEST_SESSION)
    const cleared = store.getRecord(HOST_TEST_SESSION)!
    expect(store.listRecords()).toHaveLength(1)
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(tab)
    expect(cleared.providerHandleChain).toEqual([])
    const ownership = listStructuredProviderSessionOwnership(store.listRecords())
    expect(ownership).toEqual([])
    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: source.providerHandleChain.at(-1)!.handle.nativeId,
        selfSessionId: 'another-conversation',
        ownership
      })
    ).toBeNull()
    expect(cleared.options).toEqual(source.options)
    expect(cleared.providerContextBoundary).toMatchObject({
      afterFence: done.fence,
      clearedAt: clock
    })
    expect(cleared.lease.claimStatus).toBe('released')
    expect(after.cursor.epoch).toBe(before.cursor.epoch)
    expect(after.items.slice(0, before.items.length)).toEqual(before.items)
    expect(await clearRows()).toHaveLength(1)
    expect(adapter.acquire).toHaveBeenCalledTimes(1)
    expect(
      host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.lastEndedChild?.cause
    ).toBe('context-clear')
  })

  it('starts a fresh provider context on the first send using the clear answer fence', async () => {
    const previous = store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!.handle.nativeId
    const done = await clearCommits()
    const params = sendParams('after clear')
    params.envelope.expectedRuntimeFence = done.fence
    expect(await host.send(caller, params)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1))
    const last = vi.mocked(adapter.acquire).mock.calls.at(-1)![0]
    expect(last.identity.providerHandle).toBeNull()
    const head = store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!
    expect(head.handle.nativeId).not.toBe(previous)
    expect(head).toMatchObject({ origin: 'created' })
    expect(head.replaces).toBeUndefined()
    expect(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain).toHaveLength(1)
  })

  it('replays the same operation and makes a new boundary for a new operation', async () => {
    const params = commandParams('clear')
    await clearCommits(params)
    const first = store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(await clearRows()).toHaveLength(1)
    await clearCommits()
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).not.toEqual(first)
    expect(await clearRows()).toHaveLength(2)
    expect(store.listRecords()).toHaveLength(1)
    expect(adapter.acquire).toHaveBeenCalledTimes(1)
  })

  it('gives different callers distinct boundaries even when their operation IDs match', async () => {
    const params = commandParams('clear')
    await clearCommits(params)
    const first = store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary
    await clearCommits(params, { callerKey: 'mobile' })
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).not.toEqual(first)
    expect(await clearRows()).toHaveLength(2)
  })

  it('rolls back the divider, boundary and ledger success together when storage fails', async () => {
    const db = openTestJournalHostDatabase(generationRoot()).db
    db.exec(
      "CREATE TEMP TRIGGER fail_clear BEFORE UPDATE ON agent_session_records WHEN instr(NEW.record_json, 'providerContextBoundary') > 0 BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    )
    const params = commandParams('clear')
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('disk full')
    expect(await clearRows()).toHaveLength(0)
    expect((await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch).toBe(before.cursor.epoch)
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).toBeUndefined()
    expect(
      store.getOperationRow(caller.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('pending')
    db.exec('DROP TRIGGER fail_clear')
    await clearCommits(params)
    expect(await clearRows()).toHaveLength(1)
    expect(
      store.getOperationRow(caller.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('succeeded')
  })

  it('replays a lost acknowledgment after the atomic commit without another divider', async () => {
    const target = journal()
    const append = target.context.clear.bind(target.context)
    vi.spyOn(target.context, 'clear').mockImplementationOnce(async (...args) => {
      await append(...args)
      throw new Error('connection lost')
    })
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('connection lost')
    expect(
      store.getOperationRow(caller.callerKey, params.envelope.clientOperationId)?.outcome.status
    ).toBe('succeeded')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(await clearRows()).toHaveLength(1)
  })

  it('does not complete when the previous process exit is unverifiable', async () => {
    vi.mocked(adapter.closeSession!).mockResolvedValueOnce(false)
    await expect(host.conversationCommand(caller, commandParams('clear'))).rejects.toThrow()
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).toBeUndefined()
    expect(await clearRows()).toHaveLength(0)
    expect(adapter.acquire).toHaveBeenCalledTimes(1)
  })

  it('starts fresh after a restart between clear and first send', async () => {
    await clearCommits()
    await restartHost()
    await host.restoreReadableSessions(store.listVisibleSessionIds())
    expect(await host.send(caller, sendParams('after restart'))).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1))
    expect(vi.mocked(adapter.acquire).mock.calls.at(-1)![0].identity.providerHandle).toBeNull()
    expect(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain).toHaveLength(1)
  })

  it('does not start an idle-released provider to clear it', async () => {
    clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    await clearCommits()
    expect(adapter.acquire).toHaveBeenCalledTimes(1)
  })

  it('refuses another clear while the first is in flight', async () => {
    const [first, second] = await Promise.all([
      host.conversationCommand(caller, commandParams('clear')),
      host.conversationCommand(caller, commandParams('clear'))
    ])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCommandInFlight' } }
    })
    expect(await clearRows()).toHaveLength(1)
  })

  it('allows independently sending a record with an old-build replacement pointer', async () => {
    const source = store.getRecord(HOST_TEST_SESSION)!
    await store.setConversationCommand(HOST_TEST_SESSION, source.lease.runtimeFence, {
      command: 'clear',
      phase: 'committed',
      state: 'completed',
      operationId: hostTestOperationId(),
      callerKey: caller.callerKey,
      replacementSessionId: 'old-clear-destination'
    })
    expect(await host.send(caller, sendParams('still this conversation'))).toMatchObject({
      ok: true
    })
  })
})
