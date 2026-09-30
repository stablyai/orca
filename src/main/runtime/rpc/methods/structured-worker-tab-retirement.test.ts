/**
 * Every structured-worker settlement has to retire the chat tab the worker start published.
 *
 * `setSessionTabVisibility(false)` only clears the DURABLE restore index. Without the snapshot
 * prune, a coordinator that dispatches and releases five structured workers leaves five dead
 * "Claude Chat" tabs in the worktree's tab bar, and opening one re-attaches the released session
 * outside orchestration's hold and eviction accounting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'

const createSpy = vi.fn()
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const { stopStructuredWorker } = await import('./orchestration-structured-worker-lifecycle')
const { createStructuredWorkerSession } = await import('./orchestration-structured-worker-session')
const { completeWorkerTerminalRelease } =
  await import('./orchestration/worker/worker-release-completion')

const WORKTREE = 'workspace-1'
const SESSION = 'session-1'
const HANDLE = 'structworker_11111111-1111-4111-a111-111111111111'
const HOST_SCOPE = { kind: 'local', hostId: 'local' } as const

function installHost(options: { closeThrows?: boolean; lease?: Record<string, unknown> } = {}) {
  let attached = true
  const setSessionTabVisibility = vi.fn(async () => {})
  const close = vi.fn(async () => {
    if (options.closeThrows) {
      throw new Error('close is queued for retry')
    }
    attached = false
  })
  setStructuredAgentSessionHost({
    setSessionTabVisibility,
    close,
    hasSession: () => attached,
    hold: async () => {},
    release: () => {},
    subscribe: () => () => {},
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: options.lease ?? {
            runtimeKind: 'native',
            claimStatus: attached ? 'live' : 'released',
            deathEvidence: attached
              ? null
              : { kind: 'exit-observed', detail: 'closed', observedAt: 1 },
            runtimeFence: 2
          }
        })
      }
    }
  } as never)
  return { close, setSessionTabVisibility }
}

type RuntimeInternals = {
  ensureStructuredAgentSessionHost(): Promise<void>
  notifyMessageArrived(...args: unknown[]): void
  emitMobileSessionTabsSnapshot(snapshot: unknown): void
}

async function runtimeShowingStructuredTab(): Promise<{
  runtime: OrcaRuntimeService
  emit: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService()
  const internal = runtime as unknown as RuntimeInternals
  internal.ensureStructuredAgentSessionHost = async () => undefined
  internal.notifyMessageArrived = vi.fn()
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WORKTREE,
    sessionId: SESSION,
    agent: 'claude',
    activate: true
  })
  const emit = vi.fn()
  const original = internal.emitMobileSessionTabsSnapshot.bind(runtime)
  internal.emitMobileSessionTabsSnapshot = (snapshot: unknown) => {
    emit(snapshot)
    original(snapshot)
  }
  return { runtime, emit }
}

async function structuredTabIds(runtime: OrcaRuntimeService): Promise<string[]> {
  const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
  return snapshot.tabs.map((tab) => tab.id)
}

function registerIdentity(): StructuredWorkerIdentity {
  return structuredWorkerIdentities.register({
    handle: HANDLE,
    sessionId: SESSION,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    worktreeId: WORKTREE,
    hostScope: HOST_SCOPE
  })
}

beforeEach(() => {
  structuredWorkerIdentities.clear()
  createSpy.mockReset()
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
})

describe('structured worker stop retires the chat tab', () => {
  it('prunes the tab from the live snapshot and re-emits it', async () => {
    installHost()
    const identity = registerIdentity()
    const { runtime, emit } = await runtimeShowingStructuredTab()
    expect(await structuredTabIds(runtime)).toEqual([`agent-session:${SESSION}`])

    await expect(stopStructuredWorker(identity, 'd1', runtime)).resolves.toEqual({
      stopped: true,
      closeAttempted: true
    })

    expect(await structuredTabIds(runtime)).toEqual([])
    const published = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
    expect(published.tabGroups?.[0]?.tabOrder ?? []).toEqual([])
    expect(published.activeTabId).toBeNull()
    expect(published.activeTabType).toBeNull()
    expect(emit).toHaveBeenCalled()
  })

  it('leaves the tab alone when the close was NOT proven', async () => {
    installHost({ closeThrows: true })
    const identity = registerIdentity()
    const { runtime } = await runtimeShowingStructuredTab()

    const stop = await stopStructuredWorker(identity, 'd1', runtime)

    expect(stop.stopped).toBe(false)
    expect(await structuredTabIds(runtime)).toEqual([`agent-session:${SESSION}`])
  })

  it('cannot turn a proven stop into a retained one when the prune throws', async () => {
    installHost()
    const identity = registerIdentity()
    const runtime = {
      forgetStructuredSessionMail: vi.fn(),
      retireStructuredAgentSessionTabFromSnapshot: vi.fn(() => {
        throw new Error('snapshot is wedged')
      })
    } as unknown as OrcaRuntimeService

    await expect(stopStructuredWorker(identity, 'd1', runtime)).resolves.toEqual({
      stopped: true,
      closeAttempted: true
    })
    expect(runtime.retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledWith(SESSION)
  })

  it('settles a runtime that has no tab surface at all', async () => {
    installHost()
    const identity = registerIdentity()
    await expect(stopStructuredWorker(identity, 'd1')).resolves.toEqual({
      stopped: true,
      closeAttempted: true
    })
  })
})

describe('structured worker release retires the chat tab', () => {
  it('prunes the tab once the release settles', async () => {
    installHost()
    const identity = registerIdentity()
    const { runtime } = await runtimeShowingStructuredTab()
    const resource = {
      id: 'resource-1',
      terminal_handle: HANDLE,
      host_scope: JSON.stringify(HOST_SCOPE),
      archive_source: 'transcript',
      archive_status: 'captured',
      ownership_state: 'owned',
      release_state: 'requested'
    } as WorkerTerminalResourceRow
    const db = {
      getWorkerDispatch: () => ({
        agent_terminal_handle: HANDLE,
        created_at: '2026-09-05 00:00:00'
      }),
      getDispatchContextById: () => null,
      isDispatchProcessCurrent: (args: { paneKey: string; processIncarnation: string }) =>
        args.paneKey === identity.paneKey &&
        args.processIncarnation === identity.processIncarnation,
      workerTerminalResourceHasIdentityConflict: () => false,
      getWorkerTerminalArchive: () => ({ kind: 'transcript_pin' }),
      commitWorkerTerminalArchiveForRelease: () => ({
        ...resource,
        release_state: 'releasing'
      }),
      settleWorkerTerminalRelease: () => ({ ...resource, release_state: 'released' }),
      markWorkerTerminalReleaseUnknown: (_id: string, error: string) => ({
        ...resource,
        release_state: 'unknown',
        release_error: error
      })
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'd1', resource })
    ).resolves.toMatchObject({ state: 'released' })

    expect(await structuredTabIds(runtime)).toEqual([])
  })

  it('settles rather than wedging when the user already closed the worker chat tab', async () => {
    // Closing the tab evicts the child and detaches the journal for good. Throwing archive_failed
    // there retained the worker forever on evidence that could never arrive, and `worker-abandon`
    // was the only way out of a release the coordinator had every right to complete.
    installHost({
      lease: {
        runtimeKind: 'native',
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'surface released', observedAt: 1 },
        runtimeFence: 2
      }
    })
    const identity = registerIdentity()
    const resource = {
      id: 'resource-2',
      terminal_handle: HANDLE,
      host_scope: JSON.stringify(HOST_SCOPE),
      archive_source: null,
      archive_status: null,
      ownership_state: 'owned',
      release_state: 'requested'
    } as unknown as WorkerTerminalResourceRow
    let stored: { kind?: string; content?: string } = {}
    const db = {
      getWorkerDispatch: () => ({
        agent_terminal_handle: HANDLE,
        created_at: '2026-09-05 00:00:00'
      }),
      getDispatchContextById: () => null,
      isDispatchProcessCurrent: (args: { paneKey: string; processIncarnation: string }) =>
        args.paneKey === identity.paneKey &&
        args.processIncarnation === identity.processIncarnation,
      workerTerminalResourceHasIdentityConflict: () => false,
      // No archive yet: the capture is what release has to get past.
      getWorkerTerminalArchive: () => undefined,
      commitWorkerTerminalArchiveForRelease: (args: { kind?: string; content?: string }) => {
        stored = args
        return { ...resource, release_state: 'releasing' }
      },
      settleWorkerTerminalRelease: () => ({ ...resource, release_state: 'released' }),
      markWorkerTerminalReleaseUnknown: (_id: string, error: string) => ({
        ...resource,
        release_state: 'unknown',
        release_error: error
      })
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({
        runtime: {
          ensureStructuredAgentSessionHost: async () => {},
          notifyMessageArrived: vi.fn(),
          forgetStructuredSessionMail: vi.fn(),
          retireStructuredAgentSessionTabFromSnapshot: vi.fn()
        } as unknown as OrcaRuntimeService,
        db,
        dispatchId: 'd2',
        resource
      })
    ).resolves.toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(stored.kind).toBe('structured_journal')
    expect(stored.content).toContain('could not be preserved')
  })
})

describe('structured worker discard retires the chat tab', () => {
  it('prunes the tab a half-started worker published', async () => {
    const { close } = installHost()
    const runtime = new OrcaRuntimeService()
    const internal = runtime as unknown as RuntimeInternals
    internal.ensureStructuredAgentSessionHost = async () => undefined
    let createdSessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      // The create is what publishes the background tab, and it publishes BEFORE the start can
      // fail — which is exactly the tab the discard has to take back.
      createdSessionId = args.envelope.sessionId
      await runtime.publishStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId: createdSessionId,
        agent: 'claude',
        activate: false
      })
      return { ok: false, refusal: { code: 'agent_session_operation_unknown', message: 'unknown' } }
    })

    await expect(
      createStructuredWorkerSession({
        runtime,
        worktreeId: WORKTREE,
        agent: 'claude',
        dispatchId: 'd_discard',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)

    expect(close).toHaveBeenCalledWith(createdSessionId)
    expect(await structuredTabIds(runtime)).toEqual([])
  })
})
