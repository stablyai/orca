/**
 * A chat tab's pointer to the conversation it shows, driven end to end: a real record store on disk,
 * the real structured host, the real runtime, and the real RPC handlers. Only the provider is faked.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from '../../agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'

const WORKTREE = `id:${HOST_TEST_LOCATION.workspaceId}`
const SOURCE_TAB = `structured-agent-session-${HOST_TEST_SESSION}`
const caller = { callerKey: 'trusted-local:runtime' }

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let acquisitions = 0
let acquireFails = false
let closeSession: ReturnType<typeof vi.fn<() => Promise<boolean>>>

function providerAdapter(): StructuredAgentSessionAdapter {
  return {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      if (acquireFails) {
        throw new Error('provider failed to start')
      }
      acquisitions++
      return {
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
          origin: 'created' as const,
          handle: {
            provider: 'codex' as const,
            threadId: `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          }
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    releaseAcquisition: async () => true,
    closeSession,
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
}

async function openHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: providerAdapter(),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => `spawn-${acquisitions}`
  })
  setStructuredAgentSessionHost(host)
}

type CallResponse = {
  ok: boolean
  result?: { ok?: boolean; value?: { replacementSessionId?: string } }
}

async function call(
  method: string,
  params: unknown,
  context: RpcDispatchStreamingOptions = {}
): Promise<CallResponse> {
  const response = await dispatcher.dispatch(
    { id: 'request', authToken: 'token', method, params },
    context
  )
  return JSON.parse(JSON.stringify(response))
}

async function createChat(sessionId: string, tabId?: string) {
  return commitStructuredAgentSessionCreate({
    runtime,
    caller,
    activate: true,
    prepared: {
      host,
      attachParams: hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        ...(tabId ? { surfaceTabId: tabId } : {})
      }),
      tab: { workspaceId: HOST_TEST_LOCATION.workspaceId, agent: 'codex' }
    }
  })
}

function envelopeFor(method: string, sessionId: string, fields: Record<string, unknown>) {
  return {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

async function clear(sessionId: string): Promise<string> {
  const response = await call('agentSession.conversationCommand', {
    command: 'clear',
    envelope: envelopeFor('agentSession.conversationCommand', sessionId, { command: 'clear' })
  })
  expect(response).toMatchObject({ ok: true, result: { ok: true } })
  const replacement = response.result?.value?.replacementSessionId
  expect(replacement).toBeDefined()
  return replacement!
}

async function send(sessionId: string, text: string) {
  const body = hostTestMessage(text)
  return call('agentSession.send', {
    body,
    envelope: envelopeFor('agentSession.send', sessionId, { body })
  })
}

async function snapshot() {
  return runtime.listMobileSessionTabs(WORKTREE)
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquisitions = 0
  acquireFails = false
  closeSession = vi.fn(async () => true)
  directory = await mkdtemp(join(tmpdir(), 'orca-chat-tab-table-'))
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the structured-chat policy reads only this one setting on these paths.
    { experimentalStructuredNativeChat: true } as ReturnType<
      OrcaRuntimeService['getClientSettings']
    >
  )
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [...STRUCTURED_AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
  })
  await openHost()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.flushAllStreamedEvents()
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a chat tab across /clear', () => {
  it('keeps sending through a second and third /clear, the tab following each replacement', async () => {
    expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    let current = HOST_TEST_SESSION
    // A pending send blocks /clear by design, so the clears run back to back and the chat sends after.
    for (let round = 0; round < 3; round++) {
      const replacement = await clear(current)
      expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
      expect(store.getSessionTabId(current)).toBeNull()
      current = replacement
    }
    expect(await send(current, 'after three clears')).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    const tabs = (await snapshot()).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'agent-session', sessionId: current })
    expect(store.listVisibleSessionIds()).toEqual([current])
  })

  // Each press carries its own operation id, so a later /clear is a new call the host answers.
  it('answers a /clear pressed again after it committed with that clear, starting nothing', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)
    const started = acquisitions
    expect(await clear(HOST_TEST_SESSION)).toBe(replacement)
    expect(acquisitions).toBe(started)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${replacement}`])
  })

  it('answers a retyped /clear whose answer was lost with that clear, the tab on its replacement', async () => {
    await createChat(HOST_TEST_SESSION)
    const persist = store.recordOperationOutcome.bind(store)
    let lost = false
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (!lost && input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        lost = true
        throw new Error('connection lost')
      }
      return persist(input)
    })
    const lostAnswer = await call('agentSession.conversationCommand', {
      command: 'clear',
      envelope: envelopeFor('agentSession.conversationCommand', HOST_TEST_SESSION, {
        command: 'clear'
      })
    })
    expect(lostAnswer.result?.ok).not.toBe(true)
    const started = acquisitions
    const replacement = await clear(HOST_TEST_SESSION)
    expect(acquisitions).toBe(started)
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${replacement}`])
    expect(await send(replacement, 'after the retry')).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  })

  it('reveals a cleared conversation in its own tab without activating the current chat', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)

    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true
    })

    const revealedTabId = store.getSessionTabId(HOST_TEST_SESSION)
    expect(revealedTabId).not.toBeNull()
    expect(revealedTabId).not.toBe(SOURCE_TAB)
    expect(revealedTabId).not.toContain(':')
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
    const published = await snapshot()
    expect(published.tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${replacement}`,
      `agent-session:${HOST_TEST_SESSION}`
    ])
    expect(published.activeTabId).toBe(`agent-session:${HOST_TEST_SESSION}`)
  })

  it('closes the cleared conversation and leaves the current chat and its tab', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)
    await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })

    expect(
      await call('session.tabs.close', {
        worktree: WORKTREE,
        tabId: `agent-session:${HOST_TEST_SESSION}`,
        reason: 'user'
      })
    ).toMatchObject({ ok: true })

    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${replacement}`])
    expect(await send(replacement, 'still here')).toMatchObject({ ok: true, result: { ok: true } })
  })

  // A worktree delete closes every chat in it; one that never started must not ask to be forced.
  it('closes a replacement that never started as settled', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)
    expect(await closeStructuredAgentSessionChild(replacement)).toEqual({
      stopped: true,
      closeAttempted: true
    })
  })

  it('puts a cleared chat back under the tab id it had when its close does not land', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)
    // Its agent starts on its first message; only a running agent has a close that can fail.
    expect(await send(replacement, 'first message')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(store.getRecord(replacement)?.lease.claimStatus).toBe('live'))
    closeSession.mockResolvedValue(false)

    const outcome = await closeStructuredAgentSessionChild(replacement)
    expect(outcome).toMatchObject({ stopped: false })
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
    closeSession.mockResolvedValue(true)
  })

  it('keeps the tab id and its pointer across a restart', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(await clear(HOST_TEST_SESSION))
    await host.flushAllStreamedEvents()

    await openHost()
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)
    expect(host.getPersistedVisibleSessionTabIndex()).toEqual({
      present: true,
      sessionIds: [replacement]
    })
  })
})

describe('other clients after a /clear from this window', () => {
  const STRUCTURED = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ]
  const clients = {
    window: { clientKind: 'runtime' as const, clientCapabilities: STRUCTURED },
    phone: { clientKind: 'mobile' as const, clientCapabilities: STRUCTURED }
  }

  /** The chat tabs a client lists, as that client is sent them. */
  async function listedChats(context: RpcDispatchStreamingOptions) {
    const response = await dispatcher.dispatch(
      {
        id: 'list',
        authToken: 'token',
        method: 'session.tabs.list',
        params: { worktree: WORKTREE }
      },
      context
    )
    const listed: { result?: { tabs?: { type: string }[] } } = JSON.parse(JSON.stringify(response))
    return (listed.result?.tabs ?? []).filter((tab) => tab.type === 'agent-session')
  }

  /** The session list each client keeps: the latest status the host published per session. */
  function sessionList(id: string): Map<string, AgentSessionStatusSummary | null> {
    const latest = new Map<string, AgentSessionStatusSummary | null>()
    host.subscribeStatus({
      id,
      emit: (event) => {
        if (event.type === 'snapshot') {
          event.sessions.forEach((session) => latest.set(session.sessionId, session))
        } else if (event.type === 'status') {
          latest.set(event.session.sessionId, event.session)
        }
      }
    })
    return latest
  }

  it('shows another window and a phone the replacement the marker names, with nothing unread', async () => {
    await createChat(HOST_TEST_SESSION)
    const lists = { window: sessionList('window-b'), phone: sessionList('phone') }
    const replacement = await clear(HOST_TEST_SESSION)
    // The stored pointer is the only source of the id: nothing a client holds can derive it.
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      phase: 'committed',
      replacementSessionId: replacement
    })
    expect(store.getSessionTabId(replacement)).toBe(SOURCE_TAB)

    for (const context of Object.values(clients)) {
      expect(await listedChats(context)).toEqual([
        expect.objectContaining({ sessionId: replacement, replacesSessionId: HOST_TEST_SESSION })
      ])
    }
    // Never started, so no client lists a turn for it to be unread.
    for (const list of Object.values(lists)) {
      expect(list.get(replacement)?.status ?? null).toBeNull()
      expect(list.get(replacement)?.turnOutcome).toBeUndefined()
    }

    expect(await send(replacement, 'first message')).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    await vi.waitFor(() => {
      for (const list of Object.values(lists)) {
        expect(list.get(replacement)).toMatchObject({ sessionId: replacement, status: 'working' })
      }
    })
    for (const context of Object.values(clients)) {
      expect(await listedChats(context)).toEqual([
        expect.objectContaining({ sessionId: replacement })
      ])
    }
  })
})

describe('session tab mutations from other clients, unchanged by the table', () => {
  it('reorders a group holding a chat for a paired client', async () => {
    await createChat(HOST_TEST_SESSION)
    await createChat('session-bravo')
    const ids = (await snapshot()).tabs.map((tab) => tab.id)
    const group = (await snapshot()).tabGroups![0]!

    expect(
      await call(
        'session.tabs.move',
        {
          worktree: WORKTREE,
          tabId: ids[1],
          targetGroupId: group.id,
          kind: 'reorder',
          tabOrder: ids.toReversed()
        },
        {
          clientKind: 'runtime',
          clientCapabilities: [
            STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
            CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          ]
        }
      )
    ).toMatchObject({ ok: true })
    expect((await snapshot()).tabGroups![0]!.tabOrder).toEqual(ids.toReversed())
  })

  it('refuses an old mobile client closing a chat it may only view', async () => {
    await createChat(HOST_TEST_SESSION)

    const response = await call(
      'session.tabs.close',
      { worktree: WORKTREE, tabId: `agent-session:${HOST_TEST_SESSION}`, reason: 'user' },
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response.ok).toBe(false)
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs).toHaveLength(1)
  })
})

describe('a create that reserves its tab', () => {
  it('answers with the reserved id and refuses a second chat under it', async () => {
    expect(await createChat(HOST_TEST_SESSION, 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe('reserved-tab')
    expect(store.getRecord('session-bravo')).toBeNull()
  })

  it('answers a create that reserved nothing with the id its tab was given', async () => {
    expect(await createChat(HOST_TEST_SESSION)).toMatchObject({
      ok: true,
      value: { tabId: SOURCE_TAB }
    })
  })

  it('restores no tab for a reserved create that stopped before its tab was published', async () => {
    const attached = await host.attach(
      caller,
      hostTestAttachParams(null, {
        envelope: {
          sessionId: HOST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        surfaceTabId: 'reserved-tab'
      })
    )
    expect(attached).toMatchObject({ ok: true })
    await host.flushAllStreamedEvents()

    await openHost()
    expect(host.getPersistedVisibleSessionTabIndex().sessionIds).toEqual([])
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
  })

  it('leaves no tab behind when the create fails, so nothing is restored and the id is free', async () => {
    acquireFails = true
    expect(await createChat(HOST_TEST_SESSION, 'reserved-tab')).toMatchObject({ ok: false })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([])

    acquireFails = false
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
  })
})

describe('a chat tab over records a newer Orca wrote', () => {
  it('opens a closed chat from history for reading', async () => {
    await createChat(HOST_TEST_SESSION)
    await host.close(HOST_TEST_SESSION, 'user-close')
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.flushAllStreamedEvents()
    await seedTestAgentSessionStoreFromNewerBuild(directory)
    await openHost()
    expect(store.readOnly).toBe(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true,
      result: { ok: true, readable: true }
    })

    expect((await snapshot()).activeTabId).toBe(`agent-session:${HOST_TEST_SESSION}`)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] tab-visibility-open: recording an opened chat tab failed',
      expect.objectContaining({ scope: 'tab-visibility-open', sessionId: HOST_TEST_SESSION })
    )
  })
})

describe('a chat tab whose restore index cannot be written', () => {
  // The index is bookkeeping: the chat is created and its tab opens, but no restart restores it.
  it('creates the chat and opens its tab, reporting the index write', async () => {
    const failure = new Error('disk I/O error')
    vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(failure)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const created = await createChat(HOST_TEST_SESSION)

    expect(created).toMatchObject({ ok: true, value: { sessionId: HOST_TEST_SESSION } })
    expect(created.ok ? created.value.tabId : null).toBeUndefined()
    expect((await snapshot()).activeTabId).toBe(`agent-session:${HOST_TEST_SESSION}`)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] tab-visibility-open: recording an opened chat tab failed',
      { scope: 'tab-visibility-open', sessionId: HOST_TEST_SESSION, error: failure }
    )
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  })
})
