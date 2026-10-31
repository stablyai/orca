import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { PersistedAgentSessionLease } from '../../../shared/agent-session-legacy-handoff-lease'
import { writeOlderBuildLease } from '../../runtime/agent-session/ownership/agent-session-older-build-lease.test-fixture'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

const CALLER = { callerKey: 'client-1' }

// Serialized delivery can exceed one second under load.
function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let probe: Mock<() => Promise<AgentSessionOwnerProbe>>
let stopOwnerProcess: Mock<(pid: number, signal: 'SIGTERM' | 'SIGKILL') => void>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

function openHost(): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: startsWhenPublished(
      {
        open: async () => ({
          reportedOptions: { model: '' }
        }),
        acquire,
        closeSession: vi.fn(async () => true),
        releaseAcquisition: vi.fn(async () => true),
        dispatch,
        cancelTurn: vi.fn(async () => ({ cancelled: false })),
        answerPrompt: vi.fn(async () => undefined),
        setOption: vi.fn(async () => undefined)
      },
      () => host
    ),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW,
    probeOwner: probe,
    stopOwnerProcess
  })
}

/** Older builds persisted these retired settlement latches. */
type OlderBuildLease = Partial<PersistedAgentSessionLease> & {
  settlementRetryRequired?: boolean
  settlementRetryId?: string
}

async function persistFromOlderBuild(lease: OlderBuildLease): Promise<void> {
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const attached = store.getRecord(SESSION)?.lease
  await host.flushAllStreamedEvents()
  // Replace the attached lease with legacy state that prevented release.
  await writeOlderBuildLease(root, SESSION, { ...attached, ...lease })
  store = await openTestAgentSessionRecordStore(root)
  acquire.mockClear()
  openHost()
}

/** Wait for delivery settlement; acceptance alone does not prove provider handover. */
async function delivered(text: string) {
  const sent = await send(text)
  expect(sent).toMatchObject({ ok: true })
  const clientMessageId = sent.ok ? sent.value.clientMessageId : ''
  const submission = async () =>
    (await host.journalSnapshot(SESSION)).submissions.find(
      (candidate) => candidate.clientMessageId === clientMessageId
    )
  await eventually(async () => {
    const current = await submission()
    expect(current?.dispatchState !== 'pending' || current?.handedOverAt !== undefined).toBe(true)
  })
  return submission()
}

async function send(text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-handoff-record-'))
  resetHostTestOperationIds()
  probe = vi.fn(async () => ({ outcome: 'pid-absent' as const }))
  stopOwnerProcess = vi.fn()
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a record an older build left mid terminal handoff', () => {
  it('loads a terminal-owned lease stopped mid return trip, and the chat accepts a send', async () => {
    await persistFromOlderBuild({
      runtimeKind: 'tui',
      runtimeFence: 2,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: `${NOW}-handoff`,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released',
      deathEvidence: { kind: 'pid-absent', detail: 'recorded pid absent on host', observedAt: NOW },
      settlementRetryRequired: true,
      settlementRetryId: `restart-eviction:${SESSION}:2`
    })
    expect(store.isSessionUnreadable(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering',
      claimStatus: 'released'
    })

    await openTestChats(host)

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      handoffOperationId: null
    })
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryRequired')
    expect(await delivered('after the upgrade')).toMatchObject({ dispatchState: 'pending' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('loads a lease released for a terminal that never started, and the chat accepts a send', async () => {
    await persistFromOlderBuild({
      runtimeFence: 2,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: `${NOW}-handoff`,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released',
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'handoff launch attempt stopped',
        observedAt: NOW
      }
    })
    expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')

    await openTestChats(host)

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      handoffOperationId: null
    })
    expect(await delivered('after the upgrade')).toMatchObject({ dispatchState: 'pending' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live' })
  })

  it('loads a chat owner quiesced for a handoff that never finished, and the chat accepts a send', async () => {
    await persistFromOlderBuild({ handoffStage: 'preparing', handoffOperationId: `${NOW}-handoff` })
    expect(store.isSessionUnreadable(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: 'recovering',
      handoffOperationId: `${NOW}-handoff`,
      claimStatus: 'live'
    })

    await openTestChats(host)

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'released'
    })
    expect(await delivered('after the upgrade')).toMatchObject({ dispatchState: 'pending' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live'
    })
  })

  it('waits out a terminal owner that is still running, never stops it, then resumes the chat', async () => {
    await persistFromOlderBuild({ runtimeKind: 'tui' })
    // Conflicted claims may be probed, never stopped.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'conflicted'
    })
    probe.mockResolvedValue({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })

    await openTestChats(host)

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'recovering'
    })
    // Both live refusal and settled rejection explain terminal ownership; only live refusal names the PID.
    const quitTerminal =
      'This chat is still open in a terminal agent (process 4242). Quit that agent to continue the chat here.'
    expect(await delivered('while the terminal still runs')).toMatchObject({
      dispatchState: 'rejected'
    })
    expect(
      (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
        item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
      )
    ).toEqual([
      "Codex couldn't restart. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    ])
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
    expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: quitTerminal }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()

    probe.mockResolvedValue({ outcome: 'pid-absent' })

    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(await delivered('after the terminal closed')).toMatchObject({
      dispatchState: 'pending'
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })
})
