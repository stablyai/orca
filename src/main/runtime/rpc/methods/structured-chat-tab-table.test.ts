import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { seedTestAgentSessionStoreFromNewerBuild } from '../../agent-session-record-store-test-harness'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { DeviceRegistry } from '../../device-registry'
import WebSocket from 'ws'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'
import {
  WORKTREE,
  SOURCE_TAB,
  caller,
  directory,
  store,
  host,
  runtime,
  dispatcher,
  acquisitions,
  closeSession,
  openHost,
  call,
  createChat,
  envelopeFor,
  clear,
  send,
  snapshot,
  setAcquireFailure
} from './structured-chat-tab-table.test-fixture'

describe('a chat tab across /clear', () => {
  it('keeps one conversation and published tab through repeated clears and a new send', async () => {
    expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
    const before = await snapshot()
    for (let round = 0; round < 3; round++) {
      expect(await clear(HOST_TEST_SESSION)).toBe(HOST_TEST_SESSION)
      expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
      const published = await snapshot()
      expect(published.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id))
      expect(published.tabGroups).toEqual(before.tabGroups)
      expect(published.activeTabId).toBe(before.activeTabId)
    }
    expect(await send(HOST_TEST_SESSION, 'after three clears')).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect((await snapshot()).tabs).toHaveLength(1)
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(store.listRecords()).toHaveLength(1)
  })

  it('records another clear while idle without starting or renaming the chat', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    const first = store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary
    const started = acquisitions
    await clear(HOST_TEST_SESSION)
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).not.toEqual(first)
    expect(acquisitions).toBe(started)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('replays a lost answer with the same tab and one divider', async () => {
    await createChat(HOST_TEST_SESSION)
    const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    const original = journal.context.clear.bind(journal.context)
    const lost = vi.spyOn(journal.context, 'clear').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost acknowledgement')
    })
    const params = {
      command: 'clear',
      envelope: envelopeFor('agentSession.conversationCommand', HOST_TEST_SESSION, {
        command: 'clear'
      })
    }
    expect((await call('agentSession.conversationCommand', params)).result?.ok).not.toBe(true)
    lost.mockRestore()
    const landed = journal.snapshot()
    expect(await call('agentSession.conversationCommand', params)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(journal.snapshot()).toEqual(landed)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('reveals the same tab from history instead of opening another conversation', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('closes the same cleared chat as settled before its next provider start', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await closeStructuredAgentSessionChild(HOST_TEST_SESSION)).toEqual({
      stopped: true,
      closeAttempted: true
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  })

  it('keeps the original tab when closing the new context is unverifiable', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await send(HOST_TEST_SESSION, 'new context')).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('live')
    )
    closeSession.mockResolvedValueOnce(false)
    expect(await closeStructuredAgentSessionChild(HOST_TEST_SESSION)).toMatchObject({
      stopped: false
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
  })

  it('keeps the same tab and conversation across restart', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    await host.flushAllStreamedEvents()
    await openHost()
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect(host.getPersistedVisibleSessionTabIndex()).toEqual({
      present: true,
      sessionIds: [HOST_TEST_SESSION]
    })
  })
})

describe('other clients after a clear', () => {
  const capabilities = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ]
  it('clears through the authenticated mobile WebSocket allowlist without replacing the tab', async () => {
    await createChat(HOST_TEST_SESSION)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      enableWebSocket: false,
      methods: [...STRUCTURED_AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
    })
    server['deviceRegistry'] = new DeviceRegistry(directory)
    const phone = server['deviceRegistry'].addDevice('phone', 'mobile')
    const socket = WebSocket.prototype
    const replies: unknown[] = []
    const before = await snapshot()
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'mobile-clear',
        method: 'agentSession.conversationCommand',
        deviceToken: phone.token,
        params: {
          command: 'clear',
          envelope: envelopeFor('agentSession.conversationCommand', HOST_TEST_SESSION, {
            command: 'clear'
          })
        }
      }),
      (response) => replies.push(JSON.parse(response)),
      () => undefined,
      undefined,
      undefined,
      phone.token,
      {
        ws: socket,
        connectionId: 'phone-connection',
        device: { deviceId: phone.deviceId, deviceToken: phone.token, scope: 'mobile' },
        clientCapabilities: capabilities,
        transport: { transport: 'direct' }
      }
    )
    expect(replies).toMatchObject([
      { ok: true, result: { ok: true, value: { command: 'clear', state: 'completed' } } }
    ])
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id))
    expect(store.getRecord(HOST_TEST_SESSION)?.providerContextBoundary).toBeDefined()
  })

  it.each(['runtime', 'mobile'] as const)(
    'keeps the published identity for a %s caller and a reconnecting reader',
    async (clientKind) => {
      await createChat(HOST_TEST_SESSION)
      const before = await snapshot()
      await clear(HOST_TEST_SESSION, { clientKind, clientCapabilities: capabilities })
      const listed = await dispatcher.dispatch(
        {
          id: 'reconnected',
          authToken: 'token',
          method: 'session.tabs.list',
          params: { worktree: WORKTREE }
        },
        { clientKind, clientCapabilities: capabilities }
      )
      expect(listed).toMatchObject({
        ok: true,
        result: {
          activeTabId: before.activeTabId,
          tabs: [{ id: `agent-session:${HOST_TEST_SESSION}`, sessionId: HOST_TEST_SESSION }]
        }
      })
      const current = await snapshot()
      expect(current.tabGroups).toEqual(before.tabGroups)
      expect(current.tabs[0]).not.toHaveProperty('replacesSessionId')
    }
  )
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
    setAcquireFailure(true)
    expect(await createChat(HOST_TEST_SESSION, 'reserved-tab')).toMatchObject({ ok: false })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([])

    setAcquireFailure(false)
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
  })
})

describe('a chat tab over records a newer Orca wrote', () => {
  it("opens a closed chat's tab from history, whose chat does not load", async () => {
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
      result: { ok: true, readable: false }
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
