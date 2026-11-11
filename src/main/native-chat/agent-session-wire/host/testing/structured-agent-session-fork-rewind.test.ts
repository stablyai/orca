import { catchUpClaudeTranscript } from '../../../../claude/claude-transcript-catch-up'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { usableJournalHistoryOrigin } from '../../../agent-session-journal/context-epochs/journal-history-origin'
import { recoverStructuredRewind } from '../../rewind/structured-rewind-recovery'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentSessionProviderHandleChainHead } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'

const caller = { callerKey: 'desktop' }
const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK: AgentSessionRewindFork = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  sourceSessionId: SOURCE,
  replacesSessionId: SOURCE,
  materialized: true,
  resumeCursor: 'fork-answer-1'
}
const key = (uuid: string) => agentJournalItemKey({ provider: 'claude', sessionId: SOURCE, uuid })
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let failAcquire: boolean
const forkForRewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['forkForRewind']>>(
  async () => ({ ok: true, fork: FORK })
)
const nameProviderConversation = vi.fn()
const closeSession = vi.fn(async () => true)

const attachParams = (fence: number | null) =>
  hostTestAttachParams(fence, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    providerHandle: { kind: 'claude', sessionId: SOURCE, leafUuid: 'answer-2' }
  })

beforeEach(async () => {
  resetHostTestOperationIds()
  failAcquire = false
  nameProviderConversation.mockClear()
  forkForRewind.mockReset()
  closeSession.mockClear()
  forkForRewind.mockImplementation(async ({ record, beforeMessage }) => ({
    ok: true,
    fork: {
      ...FORK,
      sessionId:
        beforeMessage.uuid === 'prompt-2' ? FORK.sessionId : '33333333-3333-4333-8333-333333333333',
      ...(beforeMessage.uuid === 'prompt-1' ? { resumeCursor: undefined } : {}),
      replacesSessionId: agentSessionProviderHandleChainHead(record.providerHandleChain)!.handle
        .nativeId
    }
  }))
  directory = await mkdtemp(join(tmpdir(), 'orca-fork-rewind-'))
  store = await openTestAgentSessionRecordStore(directory)
  const adapter = startsWhenPublished(
    {
      supportsCreate: (_location, agent) => agent === 'claude',
      supportsLocation: () => true,
      acquire: async (input) => {
        if (failAcquire) {
          throw new Error('Claude cannot start')
        }
        sink = input.events!
        return {
          providerChildPhase: 'starting' as const,
          process: {
            hostId: 'local',
            pid: 5001,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken: input.spawnToken
          },
          acquisitionGeneration: 'generation-1',
          link: {
            linkId: `acquire-${input.fence}`,
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW,
            origin: store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.length
              ? 'resumed'
              : 'created',
            handle: input.identity.providerHandle ?? claudeProviderHandle(SOURCE, 'answer-2')
          }
        }
      },
      open: async ({ fence }) => ({
        reportedOptions: { model: '' },
        link: {
          ...store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!,
          origin: 'resumed',
          mintedAtFence: fence
        }
      }),
      dispatch: async () => ({ state: 'unknown', reason: 'test' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => {},
      setOption: async () => {},
      rewindSupport: () => ({ supported: true }),
      forkForRewind,
      releaseAcquisition: async () => true,
      closeSession
    },
    () => host
  )
  const agents = claudeAndCodexAgents({ claude: adapter, codex: adapter })
  host = new StructuredAgentSessionHost({
    agents,
    nameProviderConversation,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
  expect(await host.attach(caller, attachParams(null))).toMatchObject({ ok: true })
  for (const [uuid, role] of [
    ['prompt-1', 'user'],
    ['answer-1', 'assistant'],
    ['prompt-2', 'user'],
    ['answer-2', 'assistant']
  ] as const) {
    sink.appendItem(
      { provider: 'claude', sessionId: SOURCE, uuid },
      { ...hostTestMessage(uuid), role },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

async function rewindSecondPrompt(uuid = 'prompt-2') {
  const fields = {
    itemId: key(uuid),
    expectedEpoch: (await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch
  }
  return host.rewind(caller, {
    ...fields,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields
      })
    }
  })
}

describe('rewinding a chat whose agent forks', () => {
  it('keeps the original conversation when saving its fork fails', async () => {
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    forkForRewind.mockRejectedValueOnce(new Error('transcript write failed'))
    await expect(rewindSecondPrompt()).rejects.toThrow('transcript write failed')
    expect(await host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toBeUndefined()
    expect(closeSession).not.toHaveBeenCalled()
  })
})

it('publishes the saved copy receipt after a crash before Claude rewind completion', async () => {
  const session = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!
  const journal = session.journal
  const items = journal.snapshot().items.map((item) => ({
    identity: parseAgentJournalItemKey(item.itemId)!,
    body: item.body,
    observedAt: item.observedAt,
    ownerFence: 0,
    turnScope: item.turnScope
  }))
  await journal.replaceEpochItems('session_created', 1, items, undefined, undefined, {
    version: 1,
    kind: 'native_copy',
    agent: 'claude',
    unit: 'claude-entry',
    providerHandle: { kind: 'claude', sessionId: SOURCE, leafUuid: 'answer-2' },
    ids: ['old-covered']
  })
  forkForRewind.mockResolvedValueOnce({
    ok: true,
    fork: { ...FORK, resumeCursor: 'copy-answer', coverage: ['copy-prompt', 'copy-answer'] }
  })
  const crash = vi
    .spyOn(journal, 'replaceEpochItems')
    .mockRejectedValueOnce(new Error('crash before completion'))
  await expect(rewindSecondPrompt()).rejects.toThrow('crash before completion')
  crash.mockRestore()
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({
    phase: 'provider-succeeded',
    providerFork: { coverage: ['copy-prompt', 'copy-answer'] }
  })
  const projects = join(directory, 'claude-home', 'projects', '-work')
  await mkdir(projects, { recursive: true })
  const nativeRows = [
    {
      type: 'user',
      uuid: 'copy-prompt',
      parentUuid: null,
      message: { role: 'user', content: 'copied prompt' }
    },
    {
      type: 'assistant',
      uuid: 'copy-answer',
      parentUuid: 'copy-prompt',
      message: {
        id: 'msg_copy',
        role: 'assistant',
        content: [{ type: 'text', text: 'copied answer' }]
      }
    },
    {
      type: 'user',
      uuid: 'CLI-during-crash',
      parentUuid: 'copy-answer',
      message: { role: 'user', content: 'new CLI prompt' }
    },
    {
      type: 'assistant',
      uuid: 'CLI-answer',
      parentUuid: 'CLI-during-crash',
      message: {
        id: 'msg_cli',
        role: 'assistant',
        content: [{ type: 'text', text: 'new CLI answer' }]
      }
    }
  ].map((row) => ({
    ...row,
    sessionId: FORK.sessionId,
    isSidechain: false,
    timestamp: '2026-11-06T12:00:00Z'
  }))
  await writeFile(
    join(projects, `${FORK.sessionId}.jsonl`),
    nativeRows.map((row) => `${JSON.stringify(row)}\n`).join('')
  )
  await journal.close()
  store = await openTestAgentSessionRecordStore(directory)
  const recovered = new AgentSessionJournal({
    identity: {
      sessionId: HOST_TEST_SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(SOURCE, 'answer-2')
    },
    database: openTestJournalHostDatabase(directory)
  })
  await recovered.open()
  await recoverStructuredRewind(
    { store, logger: createStructuredAgentSessionLogger() },
    HOST_TEST_SESSION,
    recovered,
    store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  )
  const origin = usableJournalHistoryOrigin(recovered.historyOrigin())
  expect(origin).toEqual({
    version: 1,
    kind: 'native_copy',
    agent: 'claude',
    unit: 'claude-entry',
    providerHandle: { kind: 'claude', sessionId: FORK.sessionId, leafUuid: 'copy-answer' },
    ids: ['copy-prompt', 'copy-answer']
  })
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.providerFork?.coverage).toBeUndefined()
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({
    journal: recovered,
    fence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
    publish: () => {}
  })
  try {
    const open = () =>
      catchUpClaudeTranscript({
        sessionId: HOST_TEST_SESSION,
        providerSessionId: FORK.sessionId,
        leafUuid: 'copy-answer',
        claudeConfigDir: join(directory, 'claude-home'),
        cwd: '/work',
        sink: deferred.sink
      })
    expect(await open()).toBe(true)
    expect(await open()).toBe(true)
    const messages = recovered.snapshot().items.filter((item) => item.body.kind === 'message')
    expect(
      messages.flatMap((item) => (item.body.kind === 'message' ? item.body.blocks : []))
    ).toContainEqual({ type: 'text', text: 'new CLI prompt' })
    expect(
      messages.filter(
        (item) =>
          item.body.kind === 'message' &&
          item.body.blocks.some((block) => block.type === 'text' && block.text === 'new CLI answer')
      )
    ).toHaveLength(1)
  } finally {
    deferred.close()
    await recovered.close()
  }
})
