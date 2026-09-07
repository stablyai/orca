import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { encodeAgentSessionQuestionAnswers } from '../../../shared/agent-session-question-answer'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

const attachParams = (): AgentSessionAttachParams => hostTestAttachParams(null)

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let ordinal = 0

function adapter(): StructuredAgentSessionAdapter {
  const dispatch = vi.fn(async (): Promise<AgentSessionDispatchOutcome> => {
    ordinal += 1
    return {
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal }
    }
  })
  return {
    acquire,
    releaseAcquisition: vi.fn(async () => true),
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt,
    setOption: vi.fn(async () => undefined)
  }
}

async function seedGroupedQuestion(): Promise<{ itemId: string; revision: number }> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: journalDirectoryFor(root, { workspaceId: 'workspace-1', sessionId: SESSION })
  })
  const appended = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 100 },
    {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Targets',
          multiSelect: true,
          options: [
            { id: 'target-web', label: 'Web' },
            { id: 'target-mobile', label: 'Mobile' }
          ]
        },
        {
          id: 'q2',
          question: 'Host',
          multiSelect: false,
          options: [],
          freeTextQuestionId: 'q2'
        }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1 }
  )
  return { itemId: appended.itemId, revision: appended.revision }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-grouped-'))
  resetHostTestOperationIds()
  ordinal = 0
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  answerPrompt = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('grouped question admission', () => {
  it('admits renderer question-group payloads with child ids and multi-select answers', async () => {
    const prompt = await seedGroupedQuestion()
    const attached = await host.attach(CALLER, attachParams())
    expect(attached.ok).toBe(true)
    const optionId = encodeAgentSessionQuestionAnswers([
      { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
      { questionId: 'q2', optionIds: [], other: 'SSH host' }
    ])
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:question', fields),
      kind: 'question',
      ...fields
    })
    expect(result).toMatchObject({ ok: true, value: { resolution: { state: 'resolved' } } })
    expect(answerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: prompt.itemId, optionId })
    )
  })
})
