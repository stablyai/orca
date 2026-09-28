import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { encodeAgentSessionQuestionAnswers } from '../../../shared/agent-session-question-answer'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 100 }
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('seedGroupedQuestion requires an acquired session')
  }
  events.appendItem(identity, {
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
  })
  await host.flushStreamedEvents(SESSION)
  const itemId = agentJournalItemKey(identity)
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  const appended = page.ok ? page.page.items.find((item) => item.itemId === itemId) : null
  if (!appended) {
    throw new Error('provider question was not written to the journal')
  }
  return { itemId, revision: appended.revision }
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
  answerPrompt = vi.fn(async ({ commit }) => commit())
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
  it('reads the packed answer an older client sends into structured answers', async () => {
    const attached = await host.attach(CALLER, attachParams())
    expect(attached.ok).toBe(true)
    const prompt = await seedGroupedQuestion()
    const answers = [
      { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
      { questionId: 'q2', optionIds: [], other: 'SSH host' }
    ]
    const optionId = encodeAgentSessionQuestionAnswers(answers)
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:question', fields),
      kind: 'question',
      ...fields
    })
    expect(result).toMatchObject({
      ok: true,
      value: { resolution: { state: 'resolved', selectedOptionId: optionId, answers } }
    })
    expect(answerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: prompt.itemId, response: { kind: 'answers', answers } })
    )
  })

  it('takes structured answers past the old option-id bound and keeps the packed form for older readers', async () => {
    const attached = await host.attach(CALLER, attachParams())
    expect(attached.ok).toBe(true)
    const prompt = await seedGroupedQuestion()
    const typed = 'Proceed with the replacement, but wait for the capture. '.repeat(40)
    const answers = [
      { questionId: 'q1', optionIds: ['target-web'] },
      { questionId: 'q2', optionIds: [], other: typed }
    ]
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, answers }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:question', fields),
      kind: 'question',
      ...fields
    })

    expect(typed.length).toBeGreaterThan(1024)
    expect(result).toMatchObject({
      ok: true,
      value: {
        resolution: {
          state: 'resolved',
          selectedOptionId: encodeAgentSessionQuestionAnswers(answers),
          answers
        }
      }
    })
    expect(answerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ response: { kind: 'answers', answers } })
    )
  })

  it('refuses answers that do not match the questions without reaching the provider', async () => {
    const attached = await host.attach(CALLER, attachParams())
    expect(attached.ok).toBe(true)
    const prompt = await seedGroupedQuestion()
    const answers = [{ questionId: 'q1', optionIds: ['target-web'] }]
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, answers }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:question', fields),
      kind: 'question',
      ...fields
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(answerPrompt).not.toHaveBeenCalled()
  })
})
