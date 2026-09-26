import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
// A chat at rest, through the RPC surface a client actually calls: opening it starts nothing, what
// it can answer without an agent it answers, and the first send is what starts one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/journal-database'
import {
  journalDatabaseFile,
  journalDirectoryFor
} from '../../../native-chat/agent-session-journal/journal-paths'
import {
  HOST_TEST_LOCATION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'
import { discardStructuredWorkerSession } from './orchestration-structured-worker-session'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let rig: RestTestRig
let dispatcher: RpcDispatcher
let requests = 0

async function call(method: string, params: unknown): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
  return replies
}

/** A chat that once ran, reopened by a fresh host: nothing of it is in memory. */
async function restingChat(): Promise<void> {
  await foundRestTestChat(rig)
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    options: { model: 'gpt-saved', effort: 'high' },
    now: rig.clock.now
  })
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  rig.adapter.acquire.mockClear()
  rig.adapter.dispatch.mockClear()
  rig.adapter.readOptions.mockClear()
}

beforeEach(async () => {
  requests = 0
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockImplementation(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC gate reads only this one setting.
      ({ experimentalStructuredNativeChat: true }) as ReturnType<
        OrcaRuntimeService['getClientSettings']
      >
  )
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

describe('opening a chat at rest (P2-01)', () => {
  it('reads, subscribes and answers everything without starting an agent', async () => {
    await restingChat()
    expect(rig.host.hasSession(SESSION)).toBe(false)

    const [history] = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
    const frames = await call('agentSession.subscribe', { sessionId: SESSION })
    const [options] = await call('agentSession.options', { sessionId: SESSION })
    const [commands] = await call('agentSession.commands', { sessionId: SESSION })
    const [outline] = await call('agentSession.conversationOutline', { sessionId: SESSION })
    const [status] = await call('agentSession.handoffStatus', { sessionId: SESSION })
    const [held] = await call('agentSession.hold', { sessionId: SESSION, holderId: 'pane' })

    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(history).toMatchObject({ ok: true, result: { ok: true } })
    const snapshot = frames.find((frame) => frame.ok && 'result' in frame)
    expect(snapshot).toMatchObject({ result: { type: 'snapshot', commands: null } })
    expect(options).toMatchObject({
      ok: true,
      result: { current: { model: 'gpt-saved', effort: 'high' } }
    })
    // Absent, never an empty list: the composer keeps its own menu.
    expect(commands).toMatchObject({ ok: true, result: {} })
    expect(commands?.ok && 'result' in commands && commands.result).not.toHaveProperty(
      'commands',
      []
    )
    expect(outline).toMatchObject({ ok: true })
    expect(status).toMatchObject({ ok: true })
    expect(held).toMatchObject({ ok: true, result: { held: true } })
  })

  it('starts the agent on the first send (P2-01)', async () => {
    await restingChat()
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    const sent = await rig.host.send(CALLER, restTestSend('wake up', fence))
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  })
})

describe('the accessor', () => {
  it('opens a closed conversation once, however many readers arrive together (P2-02)', async () => {
    // Written by the provider alone, so nothing but the readers below ever opens it here.
    const attached = await rig.host.attach(CALLER, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    rig.adapter.acquire.mock.calls
      .at(-1)?.[0]
      .events?.appendItem(
        { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'turn-1', ordinal: 1 },
        hostTestMessage('from the provider'),
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await rig.host.flushStreamedEvents(SESSION)
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)
    rig.adapter.acquire.mockClear()
    const open = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private open, spied to count journal opens.
      Reflect.get(rig.host, 'conversationDelivery') as { open: (id: string) => Promise<unknown> },
      'open'
    )
    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
      ),
      call('agentSession.subscribe', { sessionId: SESSION })
    ])
    const openedJournals = new Set(
      await Promise.all(open.mock.results.map((result) => result.value))
    )
    expect(openedJournals.size).toBe(1)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('opens a corrupt journal through the recovering open and still accepts a send (P2-03)', async () => {
    await foundRestTestChat(rig)
    await rig.host.flushAllStreamedEvents()
    const directory = journalDirectoryFor(rig.root, {
      workspaceId: HOST_TEST_LOCATION.workspaceId,
      sessionId: SESSION
    })
    // A row that no longer parses: the recovering open keeps the readable prefix and rebuilds.
    const opened = openJournalDatabase(journalDatabaseFile(directory))
    try {
      opened.db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('}{', 2)
    } finally {
      opened.db.close()
    }
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)

    const frames = await call('agentSession.subscribe', { sessionId: SESSION })
    expect(frames.some((frame) => !frame.ok)).toBe(false)
    expect(frames.find((frame) => frame.ok)).toMatchObject({ result: { type: 'snapshot' } })
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect((await rig.host.send(CALLER, restTestSend('after the repair', fence))).ok).toBe(true)
  })

  it('subscribes an old mobile client that holds first even when no agent can start (P2-06)', async () => {
    await restingChat()
    rig.adapter.acquire.mockRejectedValue(new Error('auth expired'))

    const [held] = await call('agentSession.hold', { sessionId: SESSION, holderId: 'mobile' })
    const frames = await call('agentSession.subscribe', { sessionId: SESSION })
    expect(held).toMatchObject({ ok: true })
    expect(frames.find((frame) => frame.ok)).toMatchObject({ result: { type: 'snapshot' } })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })
})

describe('options at rest', () => {
  it('records a pick as intent and replays it at the next start (P2-16)', async () => {
    await restingChat()
    const fields = { key: 'model', value: 'gpt-picked' }
    const [picked] = await call('agentSession.setOption', {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      },
      ...fields
    })
    expect(picked).toMatchObject({ ok: true, result: { ok: true } })
    expect(rig.store.getRecord(SESSION)?.options).toMatchObject({ model: 'gpt-picked' })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()

    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    await rig.host.send(CALLER, restTestSend('use the new model', fence))
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
    expect(rig.adapter.acquire.mock.calls[0]?.[0]).toMatchObject({
      options: expect.objectContaining({ model: 'gpt-picked' })
    })
  })

  it('answers the provider-level features of a chat at rest (P2-17)', async () => {
    await restingChat()
    Object.assign(rig.host.deps.adapter, {
      supportsThreadGoal: (_id: string, agent?: string) => agent === 'codex',
      recordsContextUsage: (_id: string, agent?: string) => agent === 'claude',
      rewindSupport: (_id: string, agent?: string) =>
        agent === 'codex' ? { supported: true } : { supported: false, reason: 'unsupported' }
    })
    const [options] = await call('agentSession.options', { sessionId: SESSION })
    expect(options).toMatchObject({
      ok: true,
      result: { threadGoal: { current: null }, rewind: { supported: true } }
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.readOptions).not.toHaveBeenCalled()
  })
})

describe('an agent exit', () => {
  it('is shown, not respawned; the next send starts the agent (P2-18)', async () => {
    await foundRestTestChat(rig)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private map, read for the child's fence and acquisition.
    const sessions = Reflect.get(rig.host, 'sessions') as Map<
      string,
      { child: { fence: number; generation: string } | null }
    >
    const running = sessions.get(SESSION)!.child!
    await rig.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'killed',
      cause: 'unexpected-exit',
      fence: running.fence,
      acquisitionGeneration: running.generation
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()

    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    await rig.host.send(CALLER, restTestSend('again', fence))
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(2))
  })
})

describe('every close withdraws what is queued (P2-29)', () => {
  it.each([
    ['the close RPC', async () => void (await call('agentSession.close', { sessionId: SESSION }))],
    ['the runtime chat close', async () => void (await closeStructuredAgentSessionChild(SESSION))],
    [
      'a discarded worker',
      () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the discard reads only this runtime member.
        discardStructuredWorkerSession(SESSION, {
          retireStructuredAgentSessionTabFromSnapshot: () => undefined
        } as never)
    ]
  ])('%s rejects a message accepted before any start, and starts nothing', async (_, close) => {
    await restingChat()
    // The delivery loop has not reached its first start yet.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private delivery loop, held before its first start.
    const loop = (Reflect.get(rig.host, 'conversationDelivery') as { loop: { wake: () => void } })
      .loop
    vi.spyOn(loop, 'wake').mockImplementation(() => undefined)
    const reader: unknown[] = []
    await rig.host.subscribe({
      id: 'reader',
      sessionId: SESSION,
      emit: (event) => reader.push(event)
    })
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect((await rig.host.send(CALLER, restTestSend('closed before it went', fence))).ok).toBe(
      true
    )

    await close()
    await vi.waitFor(() =>
      expect(JSON.stringify(reader)).toContain('provider_closed_before_delivery')
    )
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })
})
