/**
 * A chat tab's pointer to the conversation it shows, driven end to end: a real record store on disk,
 * the real structured host, the real runtime, and the real RPC handlers. Only the provider is faked.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
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
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { agentSessionStorePath } from '../../agent-session-record-store-file'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'

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
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter: providerAdapter(),
    journalRoot: directory,
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

  it('puts a cleared chat back under the tab id it had when its close does not land', async () => {
    await createChat(HOST_TEST_SESSION)
    const replacement = await clear(HOST_TEST_SESSION)
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
    expect(host.listVisibleSessionIds()).toEqual([replacement])
  })

  it('gives a reopened cleared conversation the same id when an older build drops the table', async () => {
    await createChat(HOST_TEST_SESSION)
    const first = await clear(HOST_TEST_SESSION)
    await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
    const current = await clear(first)
    const reopenedTab = store.getSessionTabId(HOST_TEST_SESSION)
    expect(reopenedTab).not.toBeNull()
    await host.flushAllStreamedEvents()

    // An older build rewrites the file from what it read, which drops the table.
    const file = agentSessionStorePath(join(directory, 'store'))
    const raw = JSON.parse(await readFile(file, 'utf-8'))
    expect(raw.sessionTabs).toHaveLength(2)
    delete raw.sessionTabs
    await writeFile(file, JSON.stringify(raw))

    await openHost()
    expect(store.getSessionTabId(current)).toBe(SOURCE_TAB)
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(reopenedTab)
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
    expect(host.listVisibleSessionIds()).toEqual([])
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
