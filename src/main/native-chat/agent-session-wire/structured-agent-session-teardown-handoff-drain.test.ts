// Host teardown against a handoff that has not finished switching owners.
//
// The flow runs on the session's serialized chain and nothing else awaits it, so a teardown that
// only flushed sinks left it writing into a journal it had just closed — and publishing a status
// against a session it had just dropped, which surfaced as an unhandled rejection.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { structuredAgentSessionHostTeardownPhases } from './structured-agent-session-host-teardown'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { StructuredHandoffTestRequests } from './structured-agent-session-handoff-test-requests'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let launchEntered: PromiseWithResolvers<void>
let launchGate: PromiseWithResolvers<void>

const requests = new StructuredHandoffTestRequests(
  NOW,
  SESSION,
  () => store.getRecord(SESSION)?.lease.runtimeFence ?? 0
)

function tuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui', ptyId: 'pty-tui' },
    process: { hostId: 'local', pid: 5200, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `tui-link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }
}

function gatedTransport(): StructuredAgentSessionHandoffTransport {
  return {
    hostLabel: 'Test host',
    launchTui: async ({ fence, spawnToken }) => {
      launchEntered.resolve()
      await launchGate.promise
      return tuiOwner(fence, spawnToken)
    },
    reproveTuiOwner: async ({ owner }) => owner,
    recoverTuiOwner: async (record) =>
      tuiOwner(record.lease.runtimeFence, record.lease.reservedSpawnToken ?? 'recovered'),
    stopRecoveredOwner: async () => undefined,
    stopFailedTuiLaunch: async () => undefined,
    closeTuiOwner: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiExit: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle'
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
      link: {
        linkId: `native-link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      }
    })),
    dispatchTurn: vi.fn(async () => ({ state: 'accepted' as const })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => true),
    supportsCreate: () => true,
    supportsRecord: () => true
  } as unknown as StructuredAgentSessionAdapter
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-teardown-handoff-drain-'))
  resetHostTestOperationIds()
  launchEntered = Promise.withResolvers<void>()
  launchGate = Promise.withResolvers<void>()
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-native',
    handoffTransport: gatedTransport(),
    resolveLaunchDirectory: async () => '/workspace',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  launchGate.resolve()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('structured agent-session host teardown', () => {
  it('waits for an in-flight handoff before dropping the session it is switching', async () => {
    // One operation-id source with attach, so the durable ledger sees no duplicate.
    const request = requests.request('to-tui', 'now', { operationId: hostTestOperationId() })
    expect(await host.requestHandoff(CALLER, request)).toMatchObject({ ok: true })
    await launchEntered.promise

    let settled = false
    const teardown = host.flushAllStreamedEvents().then(() => {
      settled = true
    })
    // Quiescence probe, not a wait for the flow: teardown must still be blocked on it.
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    expect(settled).toBe(false)

    launchGate.resolve()
    await teardown

    // Teardown stops the late TUI owner and fences the reservation before dropping the session.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'released',
      handoffStage: 'old-owner-stopped'
    })
    expect(host.hasSession(SESSION)).toBe(false)
  })

  it('names every phase, so the quit-path order is pinned rather than incidental', () => {
    const noop = async (): Promise<void> => undefined
    const phases = structuredAgentSessionHostTeardownPhases({
      holds: { dispose: noop },
      runtimeState: { stopLeaseRenewal: () => undefined, flushAllEventSinks: noop },
      handoffs: { stopTuiHistoryCatchup: () => undefined, drain: noop },
      tasks: { drainAttaches: noop },
      evictOwnedSessions: noop,
      captureResumeMarkers: () => {},
      recordResumeMarkers: noop
    })
    expect(phases.map((phase) => phase.name)).toEqual([
      'capture-resume-markers',
      'dispose-holds',
      'stop-lease-renewal',
      'stop-tui-catchup',
      'drain-handoffs',
      'drain-attaches',
      'evict-owned-sessions',
      'record-resume-markers',
      'flush-event-sinks'
    ])
  })

  it('bounds stalled recovery publication without preventing later cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = Promise.withResolvers<void>()
    const cleaned = vi.fn(async () => {})
    const flush = vi.fn(async () => cleaned())
    const phases = structuredAgentSessionHostTeardownPhases({
      holds: { dispose: cleaned },
      runtimeState: { stopLeaseRenewal: () => {}, flushAllEventSinks: flush },
      handoffs: { stopTuiHistoryCatchup: () => {}, drain: cleaned },
      tasks: { drainAttaches: cleaned },
      evictOwnedSessions: cleaned,
      captureResumeMarkers: () => {},
      recordResumeMarkers: () => pending.promise
    })
    try {
      const teardown = (async () => {
        for (const phase of phases) {
          await phase.run()
        }
      })()
      await vi.advanceTimersByTimeAsync(2000)
      await teardown
      expect(cleaned).toHaveBeenCalledTimes(5)
      expect(warning).toHaveBeenCalledWith(
        '[structured-agent-session] recording recovery capsule failed'
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.resolve()
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('gives up on a wedged handoff instead of holding the quit open', async () => {
    const request = requests.request('to-tui', 'now', { operationId: hostTestOperationId() })
    expect(await host.requestHandoff(CALLER, request)).toMatchObject({ ok: true })
    await launchEntered.promise

    // The gate is never opened: this is the flow that never comes back.
    vi.useFakeTimers()
    try {
      const teardown = host.flushAllStreamedEvents()
      // Covers both bounded phases: the resume-marker write gives up first, then the handoff drain.
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(teardown).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
