import { hostTestState } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionLease } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
/** Every settlement must clear durable restore and prune live worker chat tabs; leftover tabs can reattach released sessions outside orchestration accounting. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { partialRuntimeStore } from '../../../../orca-runtime-tests/runtime-store-partial-fixture'
import { OrcaRuntimeService } from '../../../../orca-runtime'

import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'

const createSpy = vi.fn()
vi.mock('../../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const { stopStructuredWorker } = await import('./orchestration-structured-worker-lifecycle')
const { createStructuredWorkerSession } = await import('./orchestration-structured-worker-session')
await import('../worker/worker-release-completion')

const WORKTREE = 'workspace-1'
const SESSION = 'session-1'
const HANDLE = 'structworker_11111111-1111-4111-a111-111111111111'
const HOST_SCOPE = { kind: 'local', hostId: 'local' } as const

function installHost(options: { closeThrows?: boolean; lease?: Partial<AgentSessionLease> } = {}) {
  let attached = true
  let visible = true
  const setSessionTabVisibility = vi.fn(async (_id: string, show: boolean) => {
    visible = show
  })
  const close = vi.fn(async () => {
    if (options.closeThrows) {
      throw new Error('close is queued for retry')
    }
    attached = false
  })
  const { host, store } = hostTestState()
  vi.spyOn(host, 'getSessionTabId').mockImplementation((id) =>
    visible ? `structured-agent-session-${id}` : null
  )
  vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(setSessionTabVisibility)
  vi.spyOn(host, 'close').mockImplementation(close)
  vi.spyOn(host, 'hasSession').mockImplementation(() => attached)
  vi.spyOn(host, 'subscribe').mockResolvedValue(() => {})
  vi.spyOn(store, 'getConversation').mockImplementation(() =>
    agentSessionConversationView(
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: SESSION,
          claimStatus: attached ? 'live' : 'released',
          deathEvidence: attached
            ? null
            : { kind: 'exit-observed', detail: 'closed', observedAt: 1 },
          runtimeFence: 2,
          ...options.lease
        })
      )
    )
  )
  setStructuredAgentSessionHost(host)
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
  const runtime = new OrcaRuntimeService(partialRuntimeStore())
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

    await expect(stopStructuredWorker(identity, runtime)).resolves.toEqual({
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

    const stop = await stopStructuredWorker(identity, runtime)

    expect(stop.stopped).toBe(false)
    expect(await structuredTabIds(runtime)).toEqual([`agent-session:${SESSION}`])
  })
})

describe('structured worker discard retires the chat tab', () => {
  it('prunes the tab a half-started worker published', async () => {
    const { close } = installHost()
    const runtime = new OrcaRuntimeService(partialRuntimeStore())
    const internal = runtime as unknown as RuntimeInternals
    internal.ensureStructuredAgentSessionHost = async () => undefined
    let createdSessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      // Create publishes before start can fail; failed-start discard must withdraw that existing background tab.
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
        dispatchId: 'd_discard'
      })
    ).rejects.toThrow(/was refused/)

    expect(close).toHaveBeenCalledWith(createdSessionId, 'evict', undefined)
    expect(await structuredTabIds(runtime)).toEqual([])
  })
})
