import { prepareStructuredAgentSessionCreateForWorktree } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'
import { usableJournalHistoryOrigin } from '../../../agent-session-journal/context-epochs/journal-history-origin'
import { catchUpCodexThread } from '../../../../codex/structured/threads/codex-structured-thread-catch-up'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger-test-support'
import { copyAcpConversation } from '../../../../acp/acp-conversation-copy'
import { acpLaunchSpecFor } from '../../../../acp/acp-launch-specs'
import type { AcpStructuredConnection } from '../../../../acp/acp-structured-connection'
import { PI_CWD_BUCKET_LAYOUT } from '../../../../ai-vault/session-cwd-bucket-layouts'
import { handleStructuredAgentSessionCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../agent-session-record-test-fixture'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { prepareStructuredAgentSessionFork } from '../structured-agent-session-fork'
import type { StructuredAgentSessionHost } from '../../host/structured-agent-session-host'
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

function source(agent: 'claude' | 'codex' = 'codex') {
  let admissions = 0
  let capability: 'checkpoint' | 'tip' = 'checkpoint'
  const record = agentSessionRecordFixture({
    sessionId: 'source-chat',
    provider: agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: join(rig.root, 'source-account')
    },
    options: { model: 'retired-model', effort: 'high', fastMode: 'false' },
    permissionMode: 'accept-edits',
    launchArgs: ['--no-daemon'],
    launchDirectory: rig.root,
    providerHandleChain: [
      {
        linkId: 'source-head',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1,
        handle:
          agent === 'claude' ? claudeProviderHandle(SOURCE, 'answer') : codexProviderHandle(SOURCE)
      }
    ]
  })
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'source-epoch', sequence: 5 },
    submissions: [],
    items: [
      {
        itemId: agentJournalItemKey({
          provider: 'codex',
          threadId: SOURCE,
          turnId: 'completed-turn',
          ordinal: 0
        }),
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Remember the nonce 57319' }]
        }
      },
      {
        itemId: 'legacy:codex:source:ended-root',
        sequence: 2,
        revision: 1,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'completed-turn', state: 'completed' }
      },
      {
        itemId: 'legacy:codex:source:selected-response',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        turnScope: { kind: 'turn', turnItemId: 'legacy:codex:source:ended-root' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Remembered' }] }
      },
      {
        itemId: 'legacy:codex:source:running-root',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        body: { kind: 'turn', turnId: 'active-turn', state: 'running' }
      },
      {
        itemId: 'legacy:codex:source:ended-child',
        sequence: 4,
        revision: 1,
        observedAt: 4,
        agentId: 'child',
        body: { kind: 'turn', turnId: 'child-turn', state: 'completed' }
      }
    ]
  }
  const copy = vi.fn(
    async (
      _input: Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
    ): ReturnType<NonNullable<StructuredAgentSessionAdapter['copyConversation']>> => {
      const dir =
        agent === 'claude'
          ? join(rig.root, 'source-account', 'projects', 'workspace')
          : join(rig.root, 'source-account', 'sessions', '2026', '11', '03')
      await mkdir(dir, { recursive: true })
      const filePath = join(
        dir,
        agent === 'claude' ? `${COPY}.jsonl` : `rollout-2026-11-03T19-00-00-${COPY}.jsonl`
      )
      if (agent === 'claude') {
        await writeFile(
          filePath,
          `${[
            {
              type: 'user',
              uuid: 'prompt',
              parentUuid: null,
              sessionId: COPY,
              timestamp: '2026-11-03T19:00:00.000Z',
              cwd: rig.root,
              message: { role: 'user', content: 'Remember the nonce 57319' }
            },
            {
              type: 'assistant',
              uuid: 'answer',
              parentUuid: 'prompt',
              sessionId: COPY,
              timestamp: '2026-11-03T19:00:01.000Z',
              message: {
                id: 'msg_answer',
                role: 'assistant',
                model: 'claude-opus-5-5',
                content: [{ type: 'text', text: 'Remembered' }],
                stop_reason: 'end_turn'
              }
            }
          ]
            .map((row) => JSON.stringify(row))
            .join('\n')}\n`
        )
        return {
          sessionId: COPY,
          filePath,
          coverage: {
            unit: agent === 'claude' ? 'claude-entry' : 'codex-turn',
            ids: agent === 'claude' ? ['prompt', 'answer'] : ['completed-turn']
          },
          ...(agent === 'claude' ? { resumeCursor: 'answer' } : {})
        }
      }
      await writeFile(
        filePath,
        `${[
          {
            type: 'session_meta',
            payload: { id: COPY, timestamp: '2026-11-03T19:00:00.000Z', cwd: rig.root }
          },
          {
            type: 'response_item',
            timestamp: '2026-11-03T19:00:01.000Z',
            payload: { type: 'message', role: 'user', content: 'Remember the nonce 57319' }
          }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      return {
        sessionId: COPY,
        filePath,
        coverage: { unit: 'codex-turn' as const, ids: ['completed-turn'] }
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preparation reads only these source/store/adapter facets; destination founding uses the real rig host below.
  const host = {
    deps: {
      store: {
        selectWritableRecord: () => ({ kind: 'writable' }),
        requireWritableRecord: () => record,
        listConversations: () => [],
        admittedSendCount: () => admissions
      },
      agents: { capabilities: () => ({ fork: capability }) },
      adapter: { copyConversation: copy },
      logger: { warn: vi.fn() },
      resolveWorkspacePath: async () => rig.root
    },
    journalSnapshot: async () => snapshot
  } as unknown as StructuredAgentSessionHost
  const intent = structuredAgentSessionCreateParams({
    sessionId: `${agent}_independent_child`,
    agent,
    worktree: 'id:workspace-1',
    forkFrom: {
      sessionId: record.sessionId,
      throughItemId: 'legacy:codex:source:selected-response'
    },
    now: rig.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  const prepare = () =>
    prepareStructuredAgentSessionFork({
      host,
      sessionId: record.sessionId,
      throughItemId: 'legacy:codex:source:selected-response',
      agent,
      location: record.location,
      envelope: intent.envelope
    })
  return {
    record,
    snapshot,
    copy,
    host,
    intent,
    prepare,
    admit: () => {
      admissions++
    },
    tip: () => {
      capability = 'tip'
      snapshot.items = snapshot.items.filter(
        (item) => item.itemId !== 'legacy:codex:source:running-root'
      )
    }
  }
}

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
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' }
    }
  })
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

async function prepareImportedAcpTip(stopReason: 'stop' | undefined) {
  const test = source()
  test.tip()
  const home = join(rig.root, 'omp-account')
  const sessions = join(home, 'sessions')
  const directory = join(sessions, `${PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(rig.root)[0]}--`)
  await mkdir(directory, { recursive: true })
  const transcript = (id: string) =>
    `${[
      { type: 'session', version: 3, id, cwd: rig.root },
      {
        type: 'message',
        id: 'prompt',
        parentId: null,
        message: { role: 'user', content: 'Remember 57319' }
      },
      {
        type: 'message',
        id: 'response',
        parentId: 'prompt',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Remembered' }],
          stopReason
        }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  await writeFile(join(directory, `${SOURCE}.jsonl`), transcript(SOURCE))
  test.record.provider = 'omp'
  test.record.accountHome = { variable: 'PI_CODING_AGENT_DIR', path: home }
  test.record.providerHandleChain = [
    {
      ...test.record.providerHandleChain[0]!,
      handle: { transport: 'acp', agent: 'omp', nativeId: SOURCE }
    }
  ]
  const selected = agentJournalItemKey({
    provider: 'legacy',
    agent: 'omp',
    sessionId: SOURCE,
    recordId: 'response'
  })
  test.snapshot.items = [
    {
      itemId: agentJournalItemKey({
        provider: 'legacy',
        agent: 'omp',
        sessionId: SOURCE,
        recordId: 'prompt'
      }),
      sequence: 1,
      revision: 0,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Remember 57319' }] }
    },
    {
      itemId: selected,
      sequence: 2,
      revision: 0,
      observedAt: 2,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Remembered' }] }
    }
  ]
  const env = { PI_CODING_AGENT_DIR: home, OMP_CODING_AGENT_DIR: sessions }
  test.host.deps.resolveLaunchEnv = async () => env
  const spec = acpLaunchSpecFor('omp')!
  const initialize = vi.fn(async () => ({
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { fork: {} } }
  }))
  const forkSession = vi.fn(async () => {
    await writeFile(join(directory, `${COPY}.jsonl`), transcript(COPY))
    return COPY
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native copy uses only initialize/forkSession/close on its short-lived connection.
  const connection = {
    initialize,
    forkSession,
    close: async () => true
  } as unknown as AcpStructuredConnection
  test.copy.mockImplementation((input) =>
    copyAcpConversation(
      {
        spec,
        dataDirectory: rig.root,
        readLaunch: async () => ({
          spec,
          command: 'omp',
          prefixArgs: [],
          args: ['acp'],
          cwd: rig.root,
          env,
          envToDelete: [],
          fullAccess: false,
          resume: null
        }),
        connect: () => connection
      },
      input,
      { track: () => {} }
    )
  )
  return prepareStructuredAgentSessionFork({
    host: test.host,
    agent: 'omp',
    sessionId: 'source-chat',
    throughItemId: selected,
    location: test.record.location,
    envelope: test.intent.envelope
  })
}

it('refuses an imported ACP tip with assistant prose but no native terminal evidence', async () => {
  await expect(prepareImportedAcpTip(undefined)).rejects.toMatchObject({
    refusal: { details: { reason: 'turnActive' } }
  })
})
