import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  activeStructuredAgentSessionTurnId,
  liveStructuredAgentSessionItems,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { unexpectedProviderExitOutcome } from './structured-agent-session-dead-generation-settlement'
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
const SURFACE = 'desktop-chat:1'
const GRACE_MS = 5

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let sink: StructuredAgentSessionEventSink | null
let hostErrors: unknown[]

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    closeSession,
    releaseAcquisition: vi.fn(async () => true),
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: false })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }
}

function openHost(): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    releaseGraceMs: GRACE_MS,
    now: () => NOW,
    onEventSinkError: ({ error }) => hostErrors.push(error)
  })
}

async function attach(): Promise<void> {
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
}

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function emitTurnLifecycle(state: 'running' | 'completed', ordinal: number): void {
  sink?.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal },
    { kind: 'status', text: state, turnLifecycle: { turnId: 'turn-1', state } }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-settlement-lifecycle-'))
  resetHostTestOperationIds()
  sink = null
  hostErrors = []
  let generation = 0
  acquire = vi.fn(async ({ fence, spawnToken, events }) => {
    sink = events ?? null
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: `generation-${++generation}`,
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  closeSession = vi.fn(async () => true)
  dispatch = vi.fn(async () => ({ state: 'rejected' as const, reason: 'unused' }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('settlement during replacement acquisition', () => {
  it('keeps attach and send writable when settlement fails, then settles on reopen', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    emitTurnLifecycle('running', 1)
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      {
        kind: 'approval',
        title: 'Old approval',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    )
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 3 },
      {
        kind: 'question',
        question: 'Old question',
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    )
    await host.flushStreamedEvents(SESSION)
    const runtimeState = (
      host as unknown as {
        runtimeState: { lifecycleBarrier: () => Promise<{ ok: false; error: Error }> }
      }
    ).runtimeState
    vi.spyOn(runtimeState, 'lifecycleBarrier').mockResolvedValueOnce({
      ok: false,
      error: new Error('journal failed')
    })
    const appendSettlement = vi
      .spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch')
      .mockRejectedValue(new Error('settlement still unavailable'))
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      settlementRetryRequired: true,
      runtimeFence: exitedFence + 2
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    const replacementFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const replacement = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(replacement.ok).toBe(true)
    if (!replacement.ok) {
      throw new Error('replacement history unreadable')
    }
    expect(
      liveStructuredAgentSessionItems(replacement.page.items, replacementFence).filter(
        (item) =>
          (item.body.kind === 'approval' || item.body.kind === 'question') &&
          item.body.resolution.state === 'pending'
      )
    ).toEqual([])
    expect(
      activeStructuredAgentSessionTurnId(
        liveStructuredAgentSessionItems(replacement.page.items, replacementFence)
      )
    ).toBeNull()
    expect(projectStructuredAgentSessionStatus(replacement.page.items, [], replacementFence)).toBe(
      'idle'
    )
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'after-exit', ordinal: 1 }
    })
    const body = hostTestMessage('a new message after the failed settlement')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    vi.useFakeTimers()
    try {
      host.release(SESSION, SURFACE)
      await vi.advanceTimersByTimeAsync(GRACE_MS * 3)
      expect(closeSession).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))

    appendSettlement.mockRestore()
    expect(await host.attach(CALLER, hostTestAttachParams(exitedFence + 3))).toMatchObject({
      ok: true
    })
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      history.ok &&
        history.page.items.some(
          (item) => item.body.kind === 'status' && item.body.turnLifecycle?.state === 'running'
        )
    ).toBe(false)
    expect(
      history.ok &&
        history.page.items.find(
          (item) =>
            item.body.kind === 'status' &&
            item.body.text === unexpectedProviderExitOutcome('provider exited')
        )?.recovered
    ).toBe(true)
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('keeps the newest witnessed verdict distinct after two failed generations', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    emitTurnLifecycle('running', 1)
    await host.flushStreamedEvents(SESSION)
    const appendSettlement = vi
      .spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch')
      .mockRejectedValue(new Error('journal unavailable'))
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'first exit',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      observedAt: NOW - 1
    })
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(3)
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-second', ordinal: 1 },
      { kind: 'turn', turnId: 'turn-second', state: 'running', startedAt: NOW }
    )
    await host.flushStreamedEvents(SESSION)
    await host.close(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      settlementRetryRequired: true,
      settlementRetryFence: 3,
      deathEvidence: { kind: 'exit-observed', observedAt: NOW }
    })

    appendSettlement.mockRestore()
    expect(await host.attach(CALLER, hostTestAttachParams(4))).toMatchObject({ ok: true })
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok).toBe(true)
    if (history.ok) {
      const turns = history.page.items.flatMap((item) => {
        const turn = readAgentJournalTurn(item.body)
        return turn ? [turn] : []
      })
      expect(turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ turnId: 'turn-1', state: 'unverifiable' }),
          expect.objectContaining({ turnId: 'turn-second', state: 'interrupted', completedAt: NOW })
        ])
      )
      expect(turns.find((turn) => turn.turnId === 'turn-1')).not.toHaveProperty('completedAt')
    }
    await vi.waitFor(() =>
      expect(store.getRecord(SESSION)?.lease.settlementRetryRequired).toBeUndefined()
    )
  })
})
