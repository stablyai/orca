// Records an older build persisted mid terminal handoff. That build could leave a lease at
// `preparing` or `old-owner-stopped`, or owned by a terminal (`runtimeKind: 'tui'`). This build
// has no handoff to finish, so each state loads normalized and ends in a chat the user can send to.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { PersistedAgentSessionLease } from '../../../shared/agent-session-legacy-handoff-lease'
import { writeOlderBuildLease } from '../../runtime/agent-session-older-build-lease.test-fixture'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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

const CALLER = { callerKey: 'client-1' }

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
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
    store,
    adapter: {
      acquire,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW,
    probeOwner: probe,
    stopOwnerProcess
  })
}

/** Writes the lease an older build left behind, then starts a fresh app generation over it. */
async function persistFromOlderBuild(lease: Partial<PersistedAgentSessionLease>): Promise<void> {
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  // Listed, as a chat with a tab is: the startup pass settles what a listed chat owes.
  await store.setSessionTabVisibility(SESSION, true)
  const attached = store.getRecord(SESSION)?.lease
  await host.flushAllStreamedEvents()
  // Over the attached owner: the older build's stage or terminal owner kept it from releasing.
  await writeOlderBuildLease(join(root, 'store'), SESSION, { ...attached, ...lease })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  acquire.mockClear()
  openHost()
}

/** A send is accepted at once; what became of it is the submission's state once the host's
 *  delivery settles it — handed over, or rejected with the reason the chat shows. */
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
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a record an older build left mid terminal handoff', () => {
  it('loads a terminal-owned lease stopped mid return trip, and the chat accepts a send', async () => {
    // The shape an older build wrote when its terminal owner died with a turn left to settle.
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

    await host.restoreStartupSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      handoffOperationId: null,
      settlementRetryRequired: undefined
    })
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
    // The shape an older build wrote when its terminal launch was abandoned.
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

    await host.restoreStartupSessions()

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

    await host.restoreStartupSessions()

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
    // A conflicted claim is probed but never stopped, by this build and by older ones.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'conflicted'
    })
    probe.mockResolvedValue({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })

    await host.restoreStartupSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'manual-recovery'
    })
    // Accepted, then rejected by the start that cannot take the lease: the chat says why.
    expect(await delivered('while the terminal still runs')).toMatchObject({
      dispatchState: 'rejected'
    })
    expect(
      (await host.journalSnapshot(SESSION)).items.filter(
        (item) => item.body.kind === 'status' && item.body.tone === 'error'
      )
    ).toHaveLength(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()

    // The user closes the terminal; the next send's start proves it gone and the chat takes over.
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
