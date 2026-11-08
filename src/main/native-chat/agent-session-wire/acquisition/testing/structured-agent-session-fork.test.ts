import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import { resolveUncommittedStructuredCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-precommit-refusal'
import { prepareStructuredAgentSessionCreateForWorktree } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { usableJournalHistoryOrigin } from '../../../agent-session-journal/context-epochs/journal-history-origin'
import { catchUpCodexThread } from '../../../../codex/structured/threads/codex-structured-thread-catch-up'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger-test-support'
import { handleStructuredAgentSessionCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { agentSessionRecordFixture } from '../../../agent-session-record-test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { prepareStructuredAgentSessionFork } from '../structured-agent-session-fork'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import {
  createRestTestRig,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/structured-agent-session-create'
import { OrcaRuntimeService } from '../../../../runtime/orca-runtime'
import { setStructuredAgentSessionHost } from '../../host/structured-agent-session-registry'
import {
  hostTestMessage,
  hostTestOperationId
} from '../../host/testing/structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'

const SOURCE = '019e6b26-18e2-7103-b7a0-7ba6bb071123'
const COPY = '019e6b26-18e2-7103-b7a0-7ba6bb071124'
let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

const source = (agent: 'claude' | 'codex' = 'codex') => forkTestSource(rig, agent)

it('copies the selected retained root, founds its relationship, and replays before source discovery', async () => {
  const test = source()
  const unchanged = structuredClone(test.record)
  const params = await test.prepare()
  expect(test.copy).toHaveBeenCalledWith(
    expect.objectContaining({
      providerSessionId: SOURCE,
      checkpoint: expect.objectContaining({ turnId: 'completed-turn' })
    })
  )
  expect(test.record).toEqual(unchanged)
  const result = await rig.host.create({ callerKey: 'device-1' }, params)
  if (!result.ok) {
    throw new Error(JSON.stringify(result))
  }
  expect(result).toMatchObject({
    ok: true,
    value: {
      page: {
        items: [
          expect.objectContaining({
            body: expect.objectContaining({
              role: 'user',
              blocks: [{ type: 'text', text: 'Remember the nonce 57319' }]
            })
          }),
          expect.objectContaining({
            body: expect.objectContaining({ kind: 'turn', turnId: 'completed-turn' })
          }),
          expect.objectContaining({
            body: expect.objectContaining({
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Remembered' }]
            })
          }),
          expect.objectContaining({
            body: expect.objectContaining({
              presentation: 'forked-from',
              forkedFrom: { sessionId: 'source-chat' }
            })
          })
        ]
      }
    }
  })
  expect(rig.store.getRecord(test.intent.envelope.sessionId)).toMatchObject({
    accountHome: test.record.accountHome,
    permissionMode: 'accept-edits',
    forkedFrom: {
      sessionId: 'source-chat',
      itemId: 'legacy:codex:source:selected-response',
      childBoundary: { kind: 'item' }
    },
    options: { model: 'retired-model', effort: 'high', fastMode: 'false' },
    launchArgs: ['--no-daemon'],
    providerHandleChain: [
      expect.objectContaining({
        origin: 'adopted',
        handle: {
          transport: 'codex-app-server',
          agent: 'codex',
          nativeId: '019e6b26-18e2-7103-b7a0-7ba6bb071124'
        }
      })
    ]
  })

  const sessionId = test.intent.envelope.sessionId
  const origin = {
    version: 1,
    kind: 'native_copy',
    providerHandle: { kind: 'codex', threadId: COPY },
    agent: 'codex',
    unit: 'codex-turn',
    ids: ['completed-turn']
  }
  expect(
    usableJournalHistoryOrigin(
      rig.host.collaboratorsForTests().sessions.get(sessionId)!.journal.historyOrigin()
    )
  ).toEqual(origin)

  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(test.record.location)
  const replay = await prepareStructuredAgentSessionCreateForWorktree({
    ...test.intent,
    runtime,
    ensureHost: async () => rig.host,
    caller: { callerKey: 'device-1' },
    atRest: true
  })
  expect(await rig.host.create({ callerKey: 'device-1' }, replay.attachParams)).toMatchObject({
    ok: true,
    replayed: true
  })
  await rig.restart()
  expect(await rig.host.create({ callerKey: 'device-1' }, replay.attachParams)).toMatchObject({
    ok: true,
    replayed: true
  })
  const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)!.journal
  expect(usableJournalHistoryOrigin(journal.historyOrigin())).toEqual(origin)
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({
    journal,
    fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
    publish: () => {}
  })
  try {
    await catchUpCodexThread({
      sessionId,
      threadId: COPY,
      sink: deferred.sink,
      connection: { request: async () => ({ data: [], nextCursor: null }) },
      returnedTurns: [
        ['completed-turn', 'copied'],
        ['new-cli-turn', 'new CLI']
      ].map(([id, text]) => ({
        id,
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: `${id}-user`,
            content: [{ type: 'text', text: `${text} prompt` }]
          },
          { type: 'agentMessage', id: `${id}-answer`, text: `${text} answer` }
        ]
      }))
    })
    expect(
      journal
        .snapshot()
        .items.flatMap((item) =>
          item.body.kind === 'message'
            ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
    ).toEqual(['Remember the nonce 57319', 'Remembered', 'new CLI prompt', 'new CLI answer'])
  } finally {
    deferred.close()
  }
})

it('keeps captured Codex options over native imported effort through reload and send', async () => {
  const test = source('codex')
  test.record.options = { model: 'gpt-6.1-sol', effort: 'medium', fastMode: 'false' }
  const copy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    const result = await copy(input)
    await appendFile(
      result.filePath!,
      `${JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-11-03T19:00:01.000Z',
        payload: {
          turn_id: 'completed-turn',
          cwd: rig.root,
          model: 'gpt-6.1-sol',
          effort: 'low'
        }
      })}\n`
    )
    return result
  })
  const params = await test.prepare()
  expect(await rig.host.create({ callerKey: 'device-1' }, params)).toMatchObject({ ok: true })
  const sessionId = test.intent.envelope.sessionId
  expect(rig.store.getRecord(sessionId)?.options).toEqual({
    model: 'gpt-6.1-sol',
    effort: 'medium',
    fastMode: 'false'
  })
  expect((await rig.host.readOptions(sessionId)).current).toMatchObject({
    model: 'gpt-6.1-sol',
    effort: 'medium',
    fastMode: false
  })
  await rig.restart()
  expect(rig.store.getRecord(sessionId)?.options).toEqual({
    model: 'gpt-6.1-sol',
    effort: 'medium',
    fastMode: 'false'
  })
  expect((await rig.host.readOptions(sessionId)).current).toMatchObject({
    model: 'gpt-6.1-sol',
    effort: 'medium',
    fastMode: false
  })
  rig.adapter.acquire.mockImplementation(async (input) => ({
    acquisitionGeneration: 'fork-generation',
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: rig.clock.now,
      spawnToken: input.spawnToken
    },
    link: {
      linkId: 'fork-resume',
      origin: 'resumed',
      mintedAtFence: input.fence,
      observedAt: rig.clock.now,
      handle: codexProviderHandle(COPY)
    }
  }))
  const dispatched =
    Promise.withResolvers<Parameters<StructuredAgentSessionAdapter['dispatch']>[0]>()
  rig.adapter.dispatch.mockImplementation(async (input) => {
    dispatched.resolve(input)
    return { state: 'unknown', reason: 'test' }
  })
  const body = hostTestMessage('Continue with the same settings')
  expect(
    await rig.host.send(
      { callerKey: 'device-1' },
      {
        body,
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId,
            fields: { body }
          })
        }
      }
    )
  ).toMatchObject({ ok: true })
  expect(await dispatched.promise).toMatchObject({
    sessionId,
    executionOptions: { model: 'gpt-6.1-sol', effort: 'medium', fastMode: 'false' }
  })
  expect(rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      options: { model: 'gpt-6.1-sol', effort: 'medium', fastMode: 'false' }
    })
  )
})

it('rejects a tip-only copy if a same-head send is admitted during capture', async () => {
  const test = source()
  test.tip()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.admit()
    return nativeCopy(input)
  })
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' }
    }
  })
})

it('refuses a rewind completed during copying when its context retired the selected response', async () => {
  const test = source()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.snapshot.items = []
    return nativeCopy(input)
  })
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' }
    }
  })
})

it('keeps an earlier immutable response available while an unrelated later turn streams', async () => {
  const test = source()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.admit()
    test.snapshot.items.push({
      itemId: 'later-stream',
      sequence: 5,
      revision: 1,
      observedAt: 5,
      turnScope: { kind: 'turn', turnItemId: 'legacy:codex:source:running-root' },
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'A newer response is streaming' }]
      }
    })
    return nativeCopy(input)
  })
  await expect(test.prepare()).resolves.toMatchObject({
    fork: { itemId: 'legacy:codex:source:selected-response' }
  })
})

it('keeps a checkpoint copy valid across a same-root source relaunch', async () => {
  const test = source()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.record.providerHandleChain = [
      ...test.record.providerHandleChain,
      {
        ...test.record.providerHandleChain[0]!,
        linkId: 'relaunched',
        origin: 'resumed',
        mintedAtFence: 2,
        observedAt: 9
      }
    ]
    return nativeCopy(input)
  })
  await expect(test.prepare()).resolves.toMatchObject({
    fork: { itemId: 'legacy:codex:source:selected-response' }
  })
})

it('refuses a tip copy after its source head relaunches', async () => {
  const test = source()
  test.tip()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.record.providerHandleChain = [
      ...test.record.providerHandleChain,
      {
        ...test.record.providerHandleChain[0]!,
        linkId: 'relaunched',
        origin: 'resumed',
        mintedAtFence: 2,
        observedAt: 9
      }
    ]
    return nativeCopy(input)
  })
  const result = await resolveUncommittedStructuredCreate(test.prepare)
  expect(result).toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' }
    }
  })
  expect(result).not.toHaveProperty('refusal.createAttemptRefusedBeforeCommit')
})

it('coalesces concurrent fork create replay and refuses a conflicting fork intent', async () => {
  const test = source()
  const getRecord = rig.store.getRecord.bind(rig.store)
  const writable = rig.store.requireWritableRecord.bind(rig.store)
  const select = rig.store.selectWritableRecord.bind(rig.store)
  const snapshot = rig.host.journalSnapshot.bind(rig.host)
  vi.spyOn(rig.store, 'getRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : getRecord(id)
  )
  vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : writable(id)
  )
  vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? { kind: 'writable', record: test.record } : select(id)
  )
  vi.spyOn(rig.host, 'journalSnapshot').mockImplementation((id) =>
    id === 'source-chat' ? Promise.resolve(test.snapshot) : snapshot(id)
  )
  const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
  vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
    const supported = capabilities(agent)
    return supported ? { ...supported, fork: 'checkpoint' } : null
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementation(async (input) => {
    entered.resolve()
    await release.promise
    return nativeCopy(input)
  })
  rig.host.deps.adapter.copyConversation = test.copy
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(test.record.location)
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue(undefined)
  const ctx = { runtime, clientId: 'device-1' }
  const first = handleStructuredAgentSessionCreate(test.intent, ctx)
  await entered.promise
  const replay = handleStructuredAgentSessionCreate(test.intent, ctx)
  release.resolve()
  const results = await Promise.all([first, replay])
  expect(results).toMatchObject([
    { ok: true, value: { sessionId: 'codex_independent_child' } },
    { ok: true, replayed: true, value: { sessionId: 'codex_independent_child' } }
  ])
  const conflicting = structuredAgentSessionCreateParams({
    ...test.intent,
    sessionId: test.intent.envelope.sessionId,
    forkFrom: { sessionId: 'another-source', throughItemId: 'other-response' },
    now: rig.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  expect(await handleStructuredAgentSessionCreate(conflicting, ctx)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_conflict' }
  })
})

it('forks an inherited Codex reply through its original and refuses it after the original rewinds', async () => {
  const test = source()
  test.snapshot.items[2]!.itemId = 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1'
  const first = agentSessionRecordFixture({
    ...test.record,
    sessionId: 'first-fork',
    providerHandleChain: [
      { ...test.record.providerHandleChain[0]!, handle: codexProviderHandle(COPY) }
    ],
    forkedFrom: {
      sessionId: 'source-chat',
      itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1',
      childBoundary: {
        kind: 'item',
        itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
      }
    }
  })
  const second = agentSessionRecordFixture({
    ...first,
    sessionId: 'second-fork',
    providerHandleChain: [
      {
        ...first.providerHandleChain[0]!,
        handle: codexProviderHandle('019e6b26-18e2-7103-b7a0-7ba6bb071125')
      }
    ],
    forkedFrom: {
      sessionId: 'first-fork',
      itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1',
      childBoundary: {
        kind: 'item',
        itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071125:completed-turn:1'
      }
    }
  })
  const records = new Map([test.record, first, second].map((record) => [record.sessionId, record]))
  Object.assign(test.host.deps.store, {
    getRecord: (id: string) => records.get(id) ?? null,
    selectWritableRecord: (id: string) => ({ kind: records.has(id) ? 'writable' : 'missing' }),
    requireWritableRecord: (id: string) => records.get(id)!
  })
  test.host.journalSnapshot = async (id) => {
    if (id === 'source-chat') {
      return test.snapshot
    }
    const thread = id === 'first-fork' ? COPY : '019e6b26-18e2-7103-b7a0-7ba6bb071125'
    return {
      ...test.snapshot,
      sessionId: id,
      items: test.snapshot.items.map((item) => ({
        ...item,
        itemId: item.itemId.replace(SOURCE, thread)
      }))
    }
  }
  const prepare = () =>
    prepareStructuredAgentSessionFork({
      host: test.host,
      sessionId: 'second-fork',
      throughItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071125:completed-turn:1',
      agent: 'codex',
      location: test.record.location,
      envelope: test.intent.envelope
    })
  expect((await prepare()).fork).toMatchObject({
    sessionId: 'source-chat',
    itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1'
  })
  expect(test.copy.mock.calls[0]![0]).toMatchObject({
    record: { sessionId: 'source-chat' },
    providerSessionId: '019e6b26-18e2-7103-b7a0-7ba6bb071123',
    checkpoint: { selectedItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1' }
  })
  const retainedCopies = new Map([
    ['first-fork', await test.host.journalSnapshot('first-fork')],
    ['second-fork', await test.host.journalSnapshot('second-fork')]
  ])
  test.host.journalSnapshot = async (id) => retainedCopies.get(id) ?? test.snapshot
  test.snapshot.items = test.snapshot.items.slice(0, 1)
  expect(await resolveUncommittedStructuredCreate(prepare)).toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' },
      createAttemptRefusedBeforeCommit: true
    }
  })
  records.delete('source-chat')
  expect(await resolveUncommittedStructuredCreate(prepare)).toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'recordMissing' },
      createAttemptRefusedBeforeCommit: true
    }
  })
})

it('checks an inherited tip against the original and refuses after the original advances', async () => {
  const test = source()
  test.tip()
  const inherited = structuredClone(test.snapshot)
  test.record.forkedFrom = {
    sessionId: 'original',
    itemId: 'legacy:codex:source:selected-response',
    childBoundary: { kind: 'item', itemId: 'legacy:codex:source:selected-response' }
  }
  const original = { ...test.record, sessionId: 'original', forkedFrom: undefined }
  test.host.deps.store.requireWritableRecord = (id) => (id === 'original' ? original : test.record)
  test.host.deps.store.getRecord = (id) => (id === 'original' ? original : test.record)
  test.host.journalSnapshot = async (id) => (id === 'original' ? test.snapshot : inherited)
  expect((await test.prepare()).fork?.sessionId).toBe('original')
  test.snapshot.items.push({
    itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:later-user:0',
    sequence: 10,
    revision: 1,
    observedAt: 10,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'new original prompt' }] }
  })
  expect(await resolveUncommittedStructuredCreate(test.prepare)).toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'turnActive' },
      createAttemptRefusedBeforeCommit: true
    }
  })
})
