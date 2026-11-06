import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import {
  hostTestMessage,
  hostTestOperationId
} from '../../host/testing/structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { usableJournalHistoryOrigin } from '../../../agent-session-journal/context-epochs/journal-history-origin'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acpLaunchSpecFor } from '../../../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../../../acp/acp-structured-agent-definitions'
import { copyAcpConversation } from '../../../../acp/acp-conversation-copy'
import type { AcpStructuredConnection } from '../../../../acp/acp-structured-connection'
import { catchUpAcpHistory } from '../../../../acp/history/acp-history-catch-up'
import { OPENCODE_ACP_DIALECT } from '../../../../acp/acp-dialects/opencode-dialect'
import * as reader from '../../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { handleOpenCodeSqliteRequest } from '../../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-dispatch'
import { copyStructuredChatRecordConversation } from '../../../../ai-vault/structured-chat-conversation-copy'
import { resolveUncommittedStructuredCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-precommit-refusal'
import { openCode2ForkStore } from '../../../transcript-opencode2-fork.test-fixture'
import { agentSessionRecordFixture } from '../../../agent-session-record-test-fixture'
import type { StructuredAgentSessionHost } from '../../host/structured-agent-session-host'
import {
  createRestTestRig,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig'
import { structuredAgentsDeclaringNothing } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { setStructuredAgentSessionHost } from '../../host/structured-agent-session-registry'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger-test-support'
import { prepareStructuredAgentSessionFork } from '../structured-agent-session-fork'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionConversationCopyInput } from '../../providers/structured-agent-session-conversation-copy-input'

const sourceKey = (recordId: string) =>
  agentJournalItemKey({
    provider: 'legacy',
    agent: 'opencode',
    sessionId: 'ses_e4d7a0c31ffejclsdjiiDszHMB',
    recordId
  })
let rig: RestTestRig | undefined
let db: ReturnType<typeof openCode2ForkStore> | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  db?.close()
  db = undefined
  await rig?.dispose()
  rig = undefined
})

async function setup() {
  // The opencode registration deliberately reads a 2.x store.
  const spec = acpLaunchSpecFor('opencode')!
  const destination = await createRestTestRig({
    agents: structuredAgentsDeclaringNothing([acpStructuredAgentDefinition(spec)])
  })
  rig = destination
  const path = join(destination.root, 'opencode.db')
  db = openCode2ForkStore(path)
  const record = agentSessionRecordFixture({
    sessionId: 'source-chat',
    provider: 'opencode',
    launchDirectory: destination.root,
    accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
    providerHandleChain: [
      {
        linkId: 'source',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1,
        handle: { transport: 'acp', agent: 'opencode', nativeId: 'ses_e4d7a0c31ffejclsdjiiDszHMB' }
      }
    ]
  })
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'source', sequence: 3 },
    submissions: [],
    items: [
      {
        itemId: sourceKey('source-user'),
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'source prompt' }] }
      },
      {
        itemId: sourceKey('source-turn'),
        sequence: 2,
        revision: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: sourceKey('source-turn'), state: 'completed' }
      },
      {
        itemId: sourceKey('source-answer'),
        sequence: 3,
        revision: 1,
        observedAt: 1,
        turnScope: { kind: 'turn', turnItemId: sourceKey('source-turn') },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'source answer' }]
        }
      }
    ]
  }
  const fork = vi.fn(async () => 'ses_e4d797526ffee7BYM6ri3gpmbg')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native copying calls only these connection methods.
  const connection = {
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { fork: {} } }
    }),
    forkSession: fork,
    close: async () => true
  } as unknown as AcpStructuredConnection
  const copy = (input: StructuredAgentSessionConversationCopyInput) =>
    copyAcpConversation(
      {
        spec: {
          ...spec,
          account: { ...spec.account, resolve: async () => record.accountHome },
          transcriptImport: { ...spec.transcriptImport!, conversationStore: () => path }
        },
        dataDirectory: destination.root,
        readLaunch: async () => ({
          spec,
          command: 'opencode',
          prefixArgs: [],
          args: ['acp'],
          cwd: destination.root,
          env: {},
          envToDelete: [],
          fullAccess: false,
          resume: null
        }),
        connect: () => connection
      },
      input,
      { track: () => {} }
    )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: source preparation/terminal copying use only this store, registry, snapshot and adapter.
  const source = {
    deps: {
      store: {
        selectWritableRecord: () => ({ kind: 'writable' }),
        requireWritableRecord: () => record,
        listConversations: () => [],
        admittedSendCount: () => 0
      },
      agents: { capabilities: () => ({ fork: 'tip' }) },
      adapter: { copyConversation: copy },
      logger: testEventSinkLogging()
    },
    journalSnapshot: async () => snapshot
  } as unknown as StructuredAgentSessionHost
  const intent = structuredAgentSessionCreateParams({
    sessionId: 'opencode-copy',
    agent: 'opencode',
    worktree: 'id:workspace-1',
    forkFrom: { sessionId: record.sessionId, throughItemId: sourceKey('source-answer') },
    now: destination.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  const prepare = () =>
    prepareStructuredAgentSessionFork({
      host: source,
      sessionId: record.sessionId,
      throughItemId: sourceKey('source-answer'),
      agent: 'opencode',
      location: record.location,
      envelope: intent.envelope
    })
  return { destination, path, record, source, fork, prepare, sessionId: intent.envelope.sessionId }
}

it('founds the M1 exact receipt and reopens the copied and immediate CLI roots exactly once', async () => {
  const test = await setup()
  vi.spyOn(reader, 'readOpenCodeForkCoverageViaWorker').mockImplementation(async (args) => {
    const response = await handleOpenCodeSqliteRequest({ ...args, id: 1, kind: 'fork-coverage' })
    if (!response.ok) {
      throw new Error(response.error)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test dispatches the real private coverage reader.
    return response.value as string[] | null
  })
  const params = await test.prepare()
  expect(await test.destination.host.create({ callerKey: 'device' }, params)).toMatchObject({
    ok: true
  })
  await test.destination.restart()
  expect(await test.destination.host.create({ callerKey: 'device' }, params)).toMatchObject({
    ok: true,
    replayed: true
  })
  const journal = test.destination.host
    .collaboratorsForTests()
    .sessions.get(test.sessionId)!.journal
  expect(usableJournalHistoryOrigin(journal.historyOrigin())).toMatchObject({
    kind: 'native_copy',
    agent: 'opencode',
    providerHandle: { kind: 'opaque', agent: 'opencode', value: 'ses_e4d797526ffee7BYM6ri3gpmbg' },
    unit: 'acp-user-message',
    ids: ['msg_1b2868ada001HhsJYcY0OtPOjp_4']
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({
    journal,
    fence: test.destination.store.getRecord(test.sessionId)!.lease.runtimeFence,
    publish: () => {}
  })
  try {
    const replayUpdate = (sessionUpdate: string, rest: Record<string, unknown>) => ({
      method: 'session/update',
      params: { sessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg', update: { sessionUpdate, ...rest } }
    })
    const frames = [
      replayUpdate('user_message_chunk', {
        messageId: 'msg_1b2868ada001HhsJYcY0OtPOjp_4',
        content: { type: 'resource_link', uri: 'file:///image.png', name: 'image' }
      }),
      replayUpdate('agent_message_chunk', {
        messageId: 'copied-answer',
        content: { type: 'text', text: 'copied native answer' }
      }),
      replayUpdate('user_message_chunk', {
        messageId: 'msg_1b2868b430019orGpEpk0E3liv',
        content: { type: 'text', text: 'CLI after fork' }
      }),
      replayUpdate('agent_message_chunk', {
        messageId: 'cli-answer',
        content: { type: 'text', text: 'CLI answer' }
      })
    ]
    for (let open = 0; open < 2; open++) {
      await catchUpAcpHistory({
        frames,
        identity: 'user-message-id',
        sink: deferred.sink,
        sessionId: test.sessionId,
        agent: 'opencode',
        providerSessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg',
        dialect: OPENCODE_ACP_DIALECT,
        assertCurrent: () => {}
      })
    }
    expect(
      journal
        .snapshot()
        .items.flatMap((item) =>
          item.body.kind === 'message'
            ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
    ).toEqual(['source prompt', 'source answer', 'CLI after fork', 'CLI answer'])
    const warn = vi.fn()
    await catchUpAcpHistory({
      get frames() {
        throw new Error('later history read failed')
      },
      identity: 'user-message-id',
      sink: deferred.sink,
      sessionId: test.sessionId,
      agent: 'opencode',
      providerSessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg',
      dialect: OPENCODE_ACP_DIALECT,
      assertCurrent: () => {},
      logger: { warn, error: vi.fn() }
    })
    expect(warn).toHaveBeenCalled()
    expect(usableJournalHistoryOrigin(journal.historyOrigin())).toMatchObject({
      kind: 'native_copy',
      ids: ['msg_1b2868ada001HhsJYcY0OtPOjp_4']
    })
  } finally {
    deferred.close()
  }
  expect(await test.destination.host.create({ callerKey: 'device' }, params)).toMatchObject({
    ok: true,
    replayed: true
  })
  test.destination.adapter.acquire.mockImplementation(async (input) => ({
    acquisitionGeneration: 'fork-generation',
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: test.destination.clock.now,
      spawnToken: input.spawnToken
    },
    link: {
      linkId: 'fork-resume',
      origin: 'resumed',
      mintedAtFence: input.fence,
      observedAt: test.destination.clock.now,
      handle: { transport: 'acp', agent: 'opencode', nativeId: 'ses_e4d797526ffee7BYM6ri3gpmbg' }
    }
  }))
  const dispatched =
    Promise.withResolvers<Parameters<StructuredAgentSessionAdapter['dispatch']>[0]>()
  test.destination.adapter.dispatch.mockImplementation(async (input) => {
    dispatched.resolve(input)
    return { state: 'unknown', reason: 'test' }
  })
  const body = hostTestMessage('Continue after the failed history read')
  expect(
    await test.destination.host.send(
      { callerKey: 'device' },
      {
        body,
        envelope: {
          sessionId: test.sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: test.sessionId,
            fields: { body }
          })
        }
      }
    )
  ).toMatchObject({ ok: true })
  expect(await dispatched.promise).toMatchObject({ sessionId: test.sessionId })
})

it('refuses a journal fork on store failure after native success, while terminal copying never reads coverage', async () => {
  const test = await setup()
  const read = vi
    .spyOn(reader, 'readOpenCodeForkCoverageViaWorker')
    .mockRejectedValue(new Error('database read failed'))
  const result = await resolveUncommittedStructuredCreate(test.prepare)
  expect(test.fork).toHaveBeenCalledOnce()
  expect(result).toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      message: expect.stringMatching(/OpenCode.*try again/)
    }
  })
  expect(test.destination.store.getRecord(test.sessionId)).toBeNull()
  expect(test.destination.host.collaboratorsForTests().sessions.has(test.sessionId)).toBe(false)
  expect(test.destination.sink.publish).not.toHaveBeenCalled()
  read.mockClear()
  setStructuredAgentSessionHost(test.source)
  expect(
    await copyStructuredChatRecordConversation(test.record, 'ses_e4d7a0c31ffejclsdjiiDszHMB')
  ).toMatchObject({
    forkedSession: { sessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg', agent: 'opencode' }
  })
  expect(read).not.toHaveBeenCalled()
})
