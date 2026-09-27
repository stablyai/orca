// Real hosts over one real store, journals and saved-status file, booted in turn the way app runs
// follow each other, for the tests of what a restarted host owes each chat before anyone opens it.
// Every journal open calls the adapter's `historyFilePath` once, so that is the open counter, and
// holding it holds the open.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionSavedStatusStore } from '../../runtime/agent-session-saved-status-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

export const STARTUP_CALLER = { callerKey: 'client-1' }

export type StartupRig = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  savedStatus: AgentSessionSavedStatusStore
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
  /** Called once per journal open, with the session id; replace its implementation to hold one. */
  historyFilePath: Mock<(sessionId: string) => Promise<string | null>>
  probeOwner: Mock<(record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>>
  statusEvents: AgentSessionStatusEvent[]
  sink: { publish: Mock; forget: Mock }
  /** Creates the chat (or attaches it again at its fence), lists its tab unless told not to, and
   *  sends `message` when one is given, waiting for its dispatch. */
  chat: (
    sessionId: string,
    options?: { workspaceId?: string; listed?: boolean; message?: string }
  ) => Promise<void>
  opensOf: (sessionId: string) => number
  /** A clean quit: teardown settles and saves, then the saved-status file closes. */
  quit: () => Promise<void>
  /** A crash: nothing settles or flushes; the process's timers and handles simply stop. */
  crash: () => Promise<void>
  /** A new app run over the same files; the counters and status stream start empty. */
  boot: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  dispose: () => Promise<void>
}

export function startupAttachParams(
  sessionId: string,
  workspaceId: string,
  fence: number | null
): AgentSessionAttachParams {
  return hostTestAttachParams(fence, {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: ''
    },
    location: { ...HOST_TEST_LOCATION, workspaceId },
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  })
}

export async function createStartupRig(): Promise<StartupRig> {
  resetHostTestOperationIds()
  const root = await mkdtemp(join(tmpdir(), 'orca-startup-pass-'))
  const directory = join(root, 'store')
  const statusEvents: AgentSessionStatusEvent[] = []
  const sink = { publish: vi.fn(), forget: vi.fn() }
  const historyFilePath = vi.fn(async (_sessionId: string): Promise<string | null> => null)
  const probeOwner: StartupRig['probeOwner'] = vi.fn(async () => ({ outcome: 'pid-absent' }))
  let ordinal = 0
  const acquire: StartupRig['acquire'] = vi.fn(async ({ fence, spawnToken, identity }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${identity.sessionId}-${fence}`,
      handle:
        identity.providerHandle.kind === 'codex'
          ? { provider: 'codex' as const, threadId: identity.providerHandle.threadId }
          : { provider: 'codex' as const, threadId: `thread-${identity.sessionId}` },
      origin: rig.store.getRecord(identity.sessionId)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    }
  }))
  const dispatch: StartupRig['dispatch'] = vi.fn(async (input) => {
    ordinal += 1
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: `thread-${input.sessionId}`,
        turnId: `turn-${ordinal}`,
        ordinal
      }
    }
  })
  const openAll: { store: AgentSessionRecordStore; savedStatus: AgentSessionSavedStatusStore }[] =
    []
  const makeHost = (
    store: AgentSessionRecordStore,
    savedStatus: AgentSessionSavedStatusStore,
    deps: Partial<StructuredAgentSessionHostDeps>
  ) =>
    new StructuredAgentSessionHost({
      store,
      adapter: {
        acquire,
        dispatch,
        closeSession: vi.fn(async () => true),
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async ({ commit }) => commit(),
        setOption: async () => undefined,
        historyFilePath: ({ identity }) => historyFilePath(identity.sessionId)
      },
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
      probeOwner,
      now: () => HOST_TEST_NOW,
      statusSink: sink,
      savedStatus,
      ...deps
    })
  const open = async (deps: Partial<StructuredAgentSessionHostDeps>) => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const savedStatus = AgentSessionSavedStatusStore.open(root)
    openAll.push({ store, savedStatus })
    const host = makeHost(store, savedStatus, deps)
    host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
    return { store, savedStatus, host }
  }
  const first = await open({})
  const rig: StartupRig = {
    root,
    ...first,
    acquire,
    dispatch,
    historyFilePath,
    probeOwner,
    statusEvents,
    sink,
    chat: async (sessionId, options = {}) => {
      const workspaceId = options.workspaceId ?? 'workspace-1'
      const attach = () =>
        rig.host.attach(
          STARTUP_CALLER,
          startupAttachParams(
            sessionId,
            workspaceId,
            rig.store.getRecord(sessionId)?.lease.runtimeFence ?? null
          )
        )
      let attached = await attach()
      if (!attached.ok && attached.refusal.code === 'agent_session_checkpoint_stale') {
        attached = await attach()
      }
      if (!attached.ok) {
        throw new Error(`attach refused: ${attached.refusal.code} ${attached.refusal.message}`)
      }
      if (options.listed !== false) {
        await rig.store.setSessionTabVisibility(sessionId, true)
      }
      if (options.message === undefined) {
        return
      }
      const dispatched = dispatch.mock.calls.length
      const body = hostTestMessage(options.message)
      const sent = await rig.host.send(STARTUP_CALLER, {
        body,
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: attached.fence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId,
            fields: { body }
          })
        }
      })
      if (!sent.ok) {
        throw new Error(`send refused: ${sent.refusal.code}`)
      }
      await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(dispatched))
    },
    opensOf: (sessionId) => historyFilePath.mock.calls.filter(([id]) => id === sessionId).length,
    quit: async () => {
      await rig.host.flushAllStreamedEvents()
      rig.savedStatus.close()
    },
    crash: async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private collaborators, reached only to stop them as a dead process would.
      const internals = rig.host as unknown as {
        runtimeState: { stopLeaseRenewal: () => void }
        lifetime: { dispose: () => void }
        sessions: Map<string, { journal: { close: () => Promise<void> } }>
      }
      internals.runtimeState.stopLeaseRenewal()
      internals.lifetime.dispose()
      for (const session of internals.sessions.values()) {
        await session.journal.close()
      }
      internals.sessions.clear()
    },
    boot: async (deps = {}) => {
      // What the new run saw, and nothing the previous one did.
      historyFilePath.mockClear()
      sink.publish.mockClear()
      sink.forget.mockClear()
      statusEvents.length = 0
      const next = await open(deps)
      rig.store = next.store
      rig.savedStatus = next.savedStatus
      rig.host = next.host
      return next.host
    },
    dispose: async () => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      openAll.forEach(({ savedStatus }) => savedStatus.close())
      await rm(root, { recursive: true, force: true })
    }
  }
  return rig
}

/** The newest row the status stream carried for a session. */
export function latestStatus(rig: StartupRig, sessionId: string) {
  for (const event of rig.statusEvents.toReversed()) {
    if (event.type === 'status' && event.session.sessionId === sessionId) {
      return event.session
    }
    if (event.type === 'snapshot') {
      const found = event.sessions.find((session) => session.sessionId === sessionId)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/** Whether the host holds this conversation open right now. */
export function isOpen(rig: StartupRig, sessionId: string): boolean {
  return rig.host.hasSession(sessionId)
}
