// The chat tab list a client asks for at startup answers from records and the tab table. It waits
// for no chat's history; each chat's history opens after the answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { latestRestTestStatus } from '../native-chat/agent-session-wire/structured-agent-session-rest-test-observations'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'

type ListingInternals = {
  store: { getWorkspaceSession: () => unknown }
  getClientSettings(): { experimentalStructuredNativeChat: boolean }
  supportsAuthoritativeSessionTabsInventory(): boolean
  hasPersistedStructuredAgentSessionStore(): boolean
  getKnownWorkspaceSessionWorktreeIds(): Set<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  refreshMobileSessionPtyInventory(): Promise<null>
  ensureStructuredAgentSessionHost(): Promise<void>
}

const CONTEXT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

let rig: RestTestRig
// Anything a test holds is let go before teardown, so a failed assertion cannot hang it.
let releaseHeld = (): void => undefined

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  releaseHeld()
  // The listing starts the history restore after its answer, without awaiting it; it finishes
  // before the rig removes its files.
  await new Promise((resolve) => setImmediate(resolve))
  await rig.host.restoreReadableSessions()
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

/** A restarted runtime whose structured host is the rig's current one. */
function restartedRuntime(workspaceSession: unknown = null) {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  const internal = runtime as unknown as ListingInternals
  internal.store = { getWorkspaceSession: () => workspaceSession }
  internal.getClientSettings = () => ({ experimentalStructuredNativeChat: true })
  // The PTY census behind an authoritative inventory is not what this pins.
  internal.supportsAuthoritativeSessionTabsInventory = () => false
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
  internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  // The census an answer takes after the tab restore: daemon, git and SSH round trips in the app.
  internal.refreshMobileSessionPtyInventory = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return null
  }
  internal.ensureStructuredAgentSessionHost = async () => {
    setStructuredAgentSessionHost(rig.host)
  }
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const listAll = async (): Promise<string[]> => {
    const response = await dispatcher.dispatch(
      { id: 'list-all', authToken: 'tok', method: 'session.tabs.listAll' },
      CONTEXT
    )
    if (!response.ok) {
      throw new Error(`listAll refused: ${JSON.stringify(response.error)}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listAll answers with the inventory shape its handler returns.
    const { snapshots } = response.result as { snapshots: RuntimeMobileSessionTabsResult[] }
    return chatIds(snapshots)
  }
  /** Mobile's stream: resolves with its first snapshots, and what had run when they were sent. */
  const subscribeAll = (seen: () => unknown) =>
    new Promise<{ ids: string[]; atAnswer: unknown }>((resolve, reject) => {
      void dispatcher.dispatchStreaming(
        { id: 'subscribe-all', authToken: 'tok', method: 'session.tabs.subscribeAll' },
        (message) => {
          const frame = JSON.parse(message)
          if (!frame.ok) {
            reject(new Error(JSON.stringify(frame.error)))
          } else if (frame.result?.type === 'snapshots') {
            resolve({ ids: chatIds(frame.result.snapshots), atAnswer: seen() })
          }
        },
        { ...CONTEXT, connectionId: 'connection-1' }
      )
    })
  return { runtime, listAll, subscribeAll }
}

function chatIds(snapshots: RuntimeMobileSessionTabsResult[]): string[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.sessionId] : []))
  )
}

/** Resolves with the answer, or with 'still waiting' once `ms` pass without one. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T | 'still waiting'> {
  return Promise.race([
    promise,
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))
  ])
}

describe('listing chat tabs at startup', () => {
  it('answers before any chat opens, then opens each one (T1)', async () => {
    const ids = ['session-1', 'session-2', 'session-3']
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()
    await rig.boot()
    const opens = Promise.withResolvers<void>()
    releaseHeld = opens.resolve
    let opened = 0
    rig.adapter.historyFilePath.mockImplementation(async () => {
      await opens.promise
      opened += 1
      return null
    })
    const { listAll } = restartedRuntime()

    expect(await within(listAll())).toEqual(ids)
    expect(opened).toBe(0)

    opens.resolve()
    await vi.waitFor(() => ids.forEach((id) => expect(rig.host.hasSession(id)).toBe(true)))
    expect(opened).toBe(3)
  })

  it.each(['listAll', 'subscribeAll'] as const)(
    'starts the history restore only after %s has answered, census and all',
    async (method) => {
      const ids = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5']
      for (const sessionId of ids) {
        await restTestChat(rig, sessionId, { message: sessionId })
      }
      await rig.crash()
      await rig.boot()
      const restore = vi.spyOn(rig.host, 'restoreReadableSessions')
      const { runtime, listAll, subscribeAll } = restartedRuntime()
      const seen = () => ({
        started: restore.mock.calls.length,
        opens: rig.adapter.historyFilePath.mock.calls.length
      })

      const answered =
        method === 'listAll' ? { ids: await listAll(), atAnswer: seen() } : await subscribeAll(seen)

      expect(answered).toEqual({ ids, atAnswer: { started: 0, opens: 0 } })
      await vi.waitFor(() => ids.forEach((id) => expect(rig.host.hasSession(id)).toBe(true)))
      expect(restore).toHaveBeenCalledOnce()
      runtime.cleanupSubscriptionsForConnection('connection-1')
    }
  )

  it.each(['listAll', 'subscribeAll'] as const)(
    'derives the /clear replacements once per loop of %s, whatever the tab and worktree count',
    async (method) => {
      const ids = Array.from({ length: 9 }, (_, index) => `session-${index + 1}`)
      for (const [index, sessionId] of ids.entries()) {
        await restTestChat(rig, sessionId, { workspaceId: `workspace-${(index % 3) + 1}` })
      }
      await rig.crash()
      await rig.boot()
      const derived = vi.spyOn(rig.host, 'conversationReplacements')
      const { runtime, listAll, subscribeAll } = restartedRuntime()
      const answer = async () =>
        method === 'listAll' ? listAll() : (await subscribeAll(() => undefined)).ids

      // The first answer also restores the tabs (one loop over every tab, one over every worktree);
      // the second only lists them.
      for (const loops of [2, 1]) {
        derived.mockClear()
        expect((await answer()).toSorted()).toEqual(ids.toSorted())
        expect(derived).toHaveBeenCalledTimes(loops)
        runtime.cleanupSubscriptionsForConnection('connection-1')
      }
    }
  )

  it('answers with a /clear committed after an earlier listing', async () => {
    await restTestChat(rig, 'session-cleared')
    await restTestChat(rig, 'session-fresh', { listed: false })
    await rig.crash()
    await rig.boot()
    const { listAll } = restartedRuntime()
    expect(await listAll()).toEqual(['session-cleared'])

    const record = rig.store.getRecord('session-cleared')!
    await rig.store.setConversationCommand('session-cleared', record.lease.runtimeFence, {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId: 'clear-1',
      callerKey: 'client-1',
      replacementSessionId: 'session-fresh'
    })

    expect(await listAll()).toEqual(['session-fresh'])
  })

  it('answers with a cleared chat revealed while the listing waits on its census', async () => {
    await restTestChat(rig, 'session-cleared')
    await restTestChat(rig, 'session-fresh', { listed: false })
    await rig.crash()
    await rig.boot()
    const { runtime, listAll } = restartedRuntime()
    expect(await listAll()).toEqual(['session-cleared'])
    const record = rig.store.getRecord('session-cleared')!
    await rig.store.setConversationCommand('session-cleared', record.lease.runtimeFence, {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId: 'clear-1',
      callerKey: 'client-1',
      replacementSessionId: 'session-fresh'
    })
    expect(await listAll()).toEqual(['session-fresh'])
    // An authoritative census that could not reach every host collects a second time; hold that one.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these runtime members exist; they are protected.
    const internal = runtime as unknown as {
      supportsAuthoritativeSessionTabsInventory(): boolean
      getAuthoritativeSessionTabsInventoryEpoch(): string
      refreshMobileSessionPtyInventory(): Promise<null>
    }
    internal.supportsAuthoritativeSessionTabsInventory = () => true
    internal.getAuthoritativeSessionTabsInventoryEpoch = () => 'epoch-1'
    let collections = 0
    const inSecond = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    releaseHeld = held.resolve
    internal.refreshMobileSessionPtyInventory = async () => {
      collections += 1
      if (collections === 2) {
        inSecond.resolve()
        await held.promise
      }
      return null
    }
    const listing = listAll()
    await inSecond.promise

    // agentSession.reveal from another client: the cleared chat opened from its history.
    const revealed = await rig.host.revealSession('session-cleared')
    await runtime.publishStructuredAgentSessionTab({ ...revealed, activate: true })
    held.resolve()

    expect(await listing).toEqual(['session-cleared'])
    expect(await listAll()).toEqual(['session-cleared'])
  })

  it('writes nothing to the record store while it lists', async () => {
    const ids = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5']
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()
    await rig.boot()
    // Settled first, so a write here could only be the listing's own.
    await rig.host.reconcileRestartLeases()
    const writes = vi.spyOn(AgentSessionStoreTransactions.prototype, 'transact')
    const { listAll } = restartedRuntime()

    expect(await listAll()).toEqual(ids)
    // Every write, a tab's visibility included, is one store transaction.
    expect(writes).not.toHaveBeenCalled()
  })

  it('lists every chat when four fail to open, and the others still get status rows (T5)', async () => {
    // The first four failing: each failure must cost only its own chat, never the chats after it.
    const ids = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6']
    const failing = ids.slice(0, 4)
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
    }
    await rig.crash()
    await rig.boot()
    rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
      if (failing.includes(sessionId)) {
        throw new Error('EACCES: permission denied')
      }
      return null
    })
    const warn = vi.spyOn(rig.host.deps.logger, 'warn').mockImplementation(() => undefined)
    const restore = vi.spyOn(rig.host, 'restoreReadableSessions')
    const { listAll } = restartedRuntime()

    expect(await within(listAll())).toEqual(ids)
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())
    await restore.mock.results[0]?.value
    for (const sessionId of ['session-5', 'session-6']) {
      expect(rig.host.hasSession(sessionId)).toBe(true)
      expect(latestRestTestStatus(rig, sessionId)).toMatchObject({
        latestPrompt: `asked ${sessionId}`
      })
    }
    const failures = warn.mock.calls.filter(
      ([message]) => message === 'restoring a chat for reading failed'
    )
    expect(failures.map(([, detail]) => detail)).toEqual(
      failing.map((sessionId) =>
        expect.objectContaining({
          sessionId,
          error: expect.objectContaining({ message: 'EACCES: permission denied' })
        })
      )
    )
    expect(await listAll()).toEqual(ids)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('lists in tab-table order, not the order the chats were created (T7)', async () => {
    for (const sessionId of ['session-c', 'session-a', 'session-b']) {
      await restTestChat(rig, sessionId, { listed: false })
    }
    for (const sessionId of ['session-b', 'session-c', 'session-a']) {
      await rig.store.setSessionTabVisibility(sessionId, true)
    }
    await rig.crash()
    await rig.boot()
    const { listAll } = restartedRuntime()

    expect(await within(listAll())).toEqual(['session-b', 'session-c', 'session-a'])
  })

  it('lists in the saved window order when the profile has no tab table (T7)', async () => {
    for (const sessionId of ['session-c', 'session-a', 'session-b']) {
      await restTestChat(rig, sessionId, { listed: false })
    }
    await rig.crash()
    const host = await rig.boot()
    vi.spyOn(host, 'getPersistedVisibleSessionTabIndex').mockReturnValue({
      present: false,
      sessionIds: []
    })
    const savedTab = (sessionId: string, sortOrder: number) => ({
      id: `agent-session:${sessionId}`,
      entityId: sessionId,
      groupId: 'group-1',
      worktreeId: 'workspace-1',
      contentType: 'agent-session',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    })
    const { listAll } = restartedRuntime({
      activeRepoId: null,
      activeWorktreeId: 'workspace-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        'workspace-1': [
          savedTab('session-a', 0),
          savedTab('session-b', 1),
          savedTab('session-c', 2)
        ]
      }
    })

    expect(await within(listAll())).toEqual(['session-a', 'session-b', 'session-c'])
  })
})
