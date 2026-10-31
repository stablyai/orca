import type * as fileOperations from 'node:fs/promises'
import * as contextSnapshots from '../../../native-chat/agent-session-context-snapshots'
import '../unused-default-rpc-methods.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
// Exercise real chat RPC: reads at rest start nothing; the first message starts the agent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks
} from '../../../../shared/structured-agent-session-options'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import {
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
import { editPersistedTestAgentSessionStore } from '../../agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { closeStructuredAgentSessionChild } from '../../agent-session/structured-agent-session-close'
import { discardStructuredWorkerSession } from './orchestration-structured-worker-session'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexDeclared } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'

vi.mock('node:fs/promises', { spy: true })
const actualFiles = await vi.importActual<typeof fileOperations>('node:fs/promises')

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let rig: RestTestRig
let dispatcher: RpcDispatcher
let requests = 0

async function call(
  method: string,
  params: unknown,
  client: RpcDispatchStreamingOptions = CLIENT
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  return replies
}

function optionRequest(value: string, sessionId = SESSION) {
  const fields = { key: 'model', value }
  return {
    ...fields,
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId,
        fields
      })
    }
  }
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

  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  await actualFiles.rm(contextSnapshots.agentSessionContextSnapshotRoot(rig.root), {
    recursive: true,
    force: true
  })
})

describe('opening a chat at rest (P2-01)', () => {
  it('commits a legacy no-choice answer before reply and replays it after upgrade and a real pick', async () => {
    await restingChat()
    const record = rig.store.getRecord(SESSION)!
    await rig.host.readOptions(SESSION)
    await rig.store.replaceSessionOptions({
      sessionId: SESSION,
      fence: record.lease.runtimeFence,
      options: { effort: 'high' },
      now: rig.clock.now
    })
    const replace = vi.spyOn(rig.store, 'replaceSessionOptions')
    rig.sink.publish.mockClear()
    const params = optionRequest('')
    const inert = { key: 'model', value: '', options: {} }
    expect((await call('agentSession.setOption', params))[0]).toMatchObject({
      result: { ok: true, replayed: false, value: inert }
    })
    expect(replace).not.toHaveBeenCalled()
    expect(rig.sink.publish).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ effort: 'high' })
    expect(
      rig.store.getOperationRow('device-1', params.envelope.clientOperationId)?.outcome
    ).toMatchObject({ optionResult: { version: 1, ...inert } })
    const warm = commitStructuredAgentSessionOptionValues(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      { model: 'gpt-saved', effort: 'high' }
    )
    expect(structuredAgentSessionOptionPicks(warm, inert.options)).toEqual([])
    const choice = await call('agentSession.setOption', optionRequest('gpt-new'))
    expect(choice[0]).toMatchObject({
      result: {
        ok: true,
        value: { value: 'gpt-new', options: { model: 'gpt-new', effort: 'high' } }
      }
    })
    expect(
      structuredAgentSessionOptionPicks(warm, { model: 'gpt-new', effort: 'high' })
    ).toHaveLength(2)
    expect((await call('agentSession.setOption', optionRequest('')))[0]).toMatchObject({
      result: { ok: true, replayed: false, value: inert }
    })
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)
    expect(
      (
        await call('agentSession.setOption', params, {
          ...CLIENT,
          clientCapabilities: [
            ...CLIENT.clientCapabilities,
            AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
          ]
        })
      )[0]
    ).toMatchObject({ result: { ok: true, replayed: true, value: inert } })
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-new', effort: 'high' })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.readOptions).not.toHaveBeenCalled()
  })

  it('preserves a v1.4.223 live ACP acceptance without reclassifying it as no-choice', async () => {
    await restingChat()
    // Captured after the old live adapter performed an empty request and reopened its database.
    const row = {
      callerKey: 'device-1',
      operationId: '1800000000000-0000000000000000000000000000ac01',
      fingerprint: 'df56281bb29dcb9d435ba37cd35c0704edcfad8e4cd94c9d85ebf8efe78d8935',
      operationTimestamp: 1800000000000,
      recordedAt: 1800000000000,
      expiresAt: 1800086700000,
      outcome: { status: 'succeeded' as const, sessionId: 'session-alpha-1' }
    }
    const envelope = {
      sessionId: 'session-alpha-1',
      clientOperationId: '1800000000000-0000000000000000000000000000ac01',
      expectedRuntimeFence: 7,
      payloadFingerprint: 'df56281bb29dcb9d435ba37cd35c0704edcfad8e4cd94c9d85ebf8efe78d8935'
    }
    const sessionId = envelope.sessionId
    await editPersistedTestAgentSessionStore(rig.root, (state) => {
      state.records[sessionId] = {
        ...state.records[SESSION],
        sessionId,
        lease: {
          ...state.records[SESSION].lease,
          sessionId,
          runtimeFence: envelope.expectedRuntimeFence
        },
        providerHandleChain: state.records[SESSION].providerHandleChain.map((link) => ({
          ...link,
          mintedAtFence: envelope.expectedRuntimeFence
        })),
        options: { model: 'historical-acp-M' }
      }
      state.operations[agentSessionOperationKey(row.callerKey, row.operationId)] = row
    })
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)
    const params = { key: 'model', value: '', envelope }
    expect((await call('agentSession.setOption', params))[0]).toMatchObject({
      result: { ok: true, replayed: true, value: { options: { model: 'historical-acp-M' } } }
    })
    await call('agentSession.setOption', optionRequest('later-model', sessionId))
    expect((await call('agentSession.setOption', params))[0]).toMatchObject({
      result: { ok: true, replayed: true, value: { options: { model: 'later-model' } } }
    })
    expect(rig.store.getOperationRow(row.callerKey, row.operationId)?.outcome).toEqual(row.outcome)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.readOptions).not.toHaveBeenCalled()
  })

  it('keeps unreadable accepted results spent and modern empty writes on their ordinary path', async () => {
    await restingChat()
    const params = optionRequest('')
    await call('agentSession.setOption', params)
    for (const optionResult of [null, { version: 2, key: 'model', value: '', options: {} }]) {
      await editPersistedTestAgentSessionStore(rig.root, (state) => {
        const row = Object.values(state.operations).find(
          (row) => row.operationId === params.envelope.clientOperationId
        )!
        row.outcome = { status: 'succeeded', sessionId: SESSION, optionResult }
      })
      await rig.restart()
      setStructuredAgentSessionHost(rig.host)
      expect((await call('agentSession.setOption', params))[0]).toMatchObject({
        result: { ok: false, refusal: { details: { reason: 'resultLost' } } }
      })
      expect(
        rig.store.getOperationRow('device-1', params.envelope.clientOperationId)?.outcome
      ).toMatchObject({ optionResult })
    }
    const modern = {
      ...CLIENT,
      clientCapabilities: [
        ...CLIENT.clientCapabilities,
        AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
      ]
    }
    expect((await call('agentSession.setOption', optionRequest(''), modern))[0]).toMatchObject({
      ok: false
    })
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-saved', effort: 'high' })
  })

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

  it('answers the owner check from the record without opening the chat', async () => {
    await restingChat()

    const [status] = await call('agentSession.handoffStatus', { sessionId: SESSION })

    expect(status).toMatchObject({ ok: true, result: { owner: expect.any(String) } })
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('starts the agent on the first send (P2-01)', async () => {
    await restingChat()
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    const sent = await rig.host.send(CALLER, restTestSend('wake up', fence))
    if (!sent.ok) {
      throw new Error(`send refused: ${sent.refusal.code}`)
    }
    // Awaits the provider's answer itself rather than polling for it, however slow the start.
    await rig.host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
    expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
  })
})

describe('the accessor', () => {
  it('opens a closed conversation once, however many readers arrive together (P2-02)', async () => {
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
    const open = vi.spyOn(rig.host.collaboratorsForTests().conversationDelivery, 'open')
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

  it('opens nothing once quit began, for a read that was already waiting on the lock', async () => {
    await restingChat()
    // The host's per-session queue, held so the read waits behind it.
    const { serialize, lifetime } = rig.host.collaboratorsForTests()
    let release = (): void => undefined
    const held = new Promise<void>((started) => {
      void serialize(SESSION, () => {
        started()
        return new Promise<void>((resolve) => (release = resolve))
      })
    })
    await held
    const read = rig.host.history({ sessionId: SESSION, direction: 'tail' })

    // Disposed as quit's first teardown step does.
    lifetime.dispose()
    release()

    await expect(read).rejects.toThrow()
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('refuses a read it cannot open with the reason, under the same code and message', async () => {
    const [missing] = await call('agentSession.history', {
      sessionId: 'session-never-created',
      direction: 'tail'
    })
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: 'agent_session_identity_required',
        message: 'agent_session_identity_required',
        data: {
          refusal: {
            code: 'agent_session_identity_required',
            details: { reason: 'recordMissing' }
          }
        }
      }
    })
  })

  it('refuses a read whose journal will not open with the classified reason, never the storage text', async () => {
    await restingChat()
    const open = vi.spyOn(rig.host.collaboratorsForTests().conversationDelivery, 'open')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const storagePath = '/Users/someone/.orca/journals/session-1/journal.sqlite'
    const failWith = (error: Error): void => {
      open.mockRejectedValue(error)
    }
    const failures = async (): Promise<RpcResponse[]> =>
      [
        ...(await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })),
        ...(await call('agentSession.subscribe', { sessionId: SESSION })),
        ...(await call('agentSession.options', { sessionId: SESSION }))
      ].filter((reply) => !reply.ok)

    failWith(
      Object.assign(new Error(`file is not a database: ${storagePath}`), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 26
      })
    )
    const corrupt = await failures()
    failWith(Object.assign(new Error(`EACCES: permission denied, open '${storagePath}'`), {}))
    const unavailable = await failures()

    for (const [replies, reason] of [
      [corrupt, 'journalCorrupt'],
      [unavailable, 'journalUnavailable']
    ] as const) {
      expect(replies).toHaveLength(3)
      for (const reply of replies) {
        expect(reply).toMatchObject({
          ok: false,
          error: {
            // Released clients still read this refusal code from the message, not passthrough code.
            code: 'runtime_error',
            message: 'agent_session_journal_unreadable',
            data: { refusal: { code: 'agent_session_journal_unreadable', details: { reason } } }
          }
        })
        expect(JSON.stringify(reply)).not.toContain(storagePath)
      }
    }
  })

  it('logs a reader reconnecting to a journal that will not open once per failure', async () => {
    await restingChat()
    const open = vi.spyOn(rig.host.collaboratorsForTests().conversationDelivery, 'open')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logged = (): unknown[] =>
      warn.mock.calls
        .filter(
          ([line]) =>
            line === '[agent-session] open-for-read: opening the conversation for a read failed'
        )
        .map(([, fields]) => fields?.error)
    const reconnect = async (): Promise<RpcResponse[]> => [
      ...(await call('agentSession.subscribe', { sessionId: SESSION })),
      ...(await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }))
    ]
    const denied = new Error('EACCES: permission denied')
    const exhausted = new Error('EMFILE: too many open files')

    open.mockRejectedValue(denied)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Every attempt is still refused with its reason; only the log is quiet.
      expect((await reconnect()).filter((reply) => !reply.ok)).toHaveLength(2)
    }
    expect(logged()).toEqual([denied])
    open.mockRejectedValue(exhausted)
    await reconnect()
    await reconnect()
    expect(logged()).toEqual([denied, exhausted])
  })

  it('refuses a damaged journal as unloadable at subscribe and send, and keeps its rows (P2-03)', async () => {
    await foundRestTestChat(rig)
    await rig.host.flushAllStreamedEvents()
    updateTestJournalRowJson(openTestJournalHostDatabase(rig.root).db, SESSION, 2, '}{')
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)

    const frames = await call('agentSession.subscribe', { sessionId: SESSION })
    expect(frames.find((frame) => !frame.ok)).toMatchObject({
      error: {
        data: {
          refusal: {
            code: 'agent_session_journal_unreadable',
            details: { reason: 'journalCorrupt' }
          }
        }
      }
    })
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect(await rig.host.send(CALLER, restTestSend('after the damage', fence))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
    })
    expect(
      liveTestJournalRows(openTestJournalHostDatabase(rig.root).db, SESSION).find(
        (row) => row.seq === 2
      )?.rowJson
    ).toBe('}{')
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
    setStructuredAgentSessionHost(await rig.restart({ agents: claudeAndCodexDeclared() }))
    Object.assign(rig.host.deps.adapter, {
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
    const running = rig.host.collaboratorsForTests().sessions.get(SESSION)!.child!
    await rig.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'killed',
      cause: 'unexpected-exit',
      fence: running.fence,
      acquisitionGeneration: running.generation!
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()

    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    await rig.host.send(CALLER, restTestSend('again', fence))
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(2))
  })

  it('whose settlement write failed is settled by the next send, which is delivered', async () => {
    await foundRestTestChat(rig)
    const open = rig.host.collaboratorsForTests().sessions.get(SESSION)!
    const running = open.child!
    // A turn in flight, so the exit has something to settle.
    rig.adapter.acquire.mock.calls
      .at(-1)?.[0]
      .events?.appendItem(
        { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'working', ordinal: 50 },
        { kind: 'turn', turnId: 'working', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await rig.host.flushStreamedEvents(SESSION)
    // Refuse both the exit write and its queued retry to test retained death evidence.
    vi.spyOn(open.journal, 'appendLifecycleBatch')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))
    await rig.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'killed',
      cause: 'unexpected-exit',
      fence: running.fence,
      acquisitionGeneration: running.generation!
    })
    // Released with its death evidence, not latched: the next acquire settles from that evidence.
    await vi.waitFor(() =>
      expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed' }
      })
    )
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})

    const sent = await rig.host.send(
      CALLER,
      restTestSend('again', rig.store.getRecord(SESSION)!.lease.runtimeFence)
    )

    if (!sent.ok) {
      throw new Error(`send refused: ${sent.refusal.code}`)
    }
    await rig.host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
    expect(
      activeStructuredAgentSessionTurnId((await rig.host.journalSnapshot(SESSION)).items)
    ).not.toBe('working')
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
    const { loop } = rig.host.collaboratorsForTests().conversationDelivery
    vi.spyOn(loop, 'wake').mockImplementation(() => Promise.resolve())
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
    // A close's rejection is a sentence with its fact beside it, never a marker.
    await vi.waitFor(() =>
      expect(JSON.stringify(reader)).toContain(
        '"reason":"The chat closed before this message was sent.","submittedAt"'
      )
    )
    expect(JSON.stringify(reader)).toContain('"rejection":{"kind":"chatClosed"}')
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })
})
