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

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let probe: Mock<() => Promise<AgentSessionOwnerProbe>>
let stopOwnerProcess: Mock<(pid: number, signal: 'SIGTERM' | 'SIGKILL') => void>

function openHost(): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
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
/** Older builds also wrote the retired settlement latch fields. */
type OlderBuildLease = Partial<PersistedAgentSessionLease> & {
  settlementRetryRequired?: boolean
  settlementRetryId?: string
}

async function persistFromOlderBuild(lease: OlderBuildLease): Promise<void> {
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const attached = store.getRecord(SESSION)?.lease
  await host.flushAllStreamedEvents()
  // Over the attached owner: the older build's stage or terminal owner kept it from releasing.
  await writeOlderBuildLease(join(root, 'store'), SESSION, { ...attached, ...lease })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  acquire.mockClear()
  openHost()
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

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      handoffOperationId: null
    })
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryRequired')
    expect(await send('after the upgrade')).toMatchObject({ ok: true })
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

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      handoffOperationId: null
    })
    expect(await send('after the upgrade')).toMatchObject({ ok: true })
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

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'released'
    })
    expect(await send('after the upgrade')).toMatchObject({ ok: true })
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

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'manual-recovery'
    })
    expect(await send('while the terminal still runs')).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()

    // The user closes the terminal; the next open proves it gone and the chat takes over.
    probe.mockResolvedValue({ outcome: 'pid-absent' })
    await host.hold(SESSION, 'surface-1')

    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(await send('after the terminal closed')).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })
})
