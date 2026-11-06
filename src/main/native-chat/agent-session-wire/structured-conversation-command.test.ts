import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

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
    probeOwner: async () => ownerProbe
  })
  hosts.push(host)
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
    open: async () => ({
      reportedOptions: { model: '' }
    }),
    acquire: vi.fn(async (input) => {
      acquisitions++
      const acquisitionGeneration = `acquisition-${acquisitions}`
      return {
        acquisitionGeneration,
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
          // A missing resume handle creates a thread even at a later fence.
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
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})
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
})
