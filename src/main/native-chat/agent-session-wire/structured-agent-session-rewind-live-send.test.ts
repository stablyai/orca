import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
// A Codex rewind left in doubt while its agent keeps running: no attach comes to settle it, so the
// next send asks the provider as an attach would, and a send refused meanwhile never poisons its id.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const caller = { callerKey: 'desktop' }
const KEPT = { provider: 'codex' as const, threadId: THREAD, turnId: 'kept', ordinal: 0 }

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let acquires = 0
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()
const recoverRewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>()
const rewindSupport = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewindSupport']>>()
const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()

function adapter(): StructuredAgentSessionAdapter {
  return {
    supportsCreate: (_location, agent) => agent === 'codex',
    supportsLocation: () => true,
    acquire: async (input) => {
      acquires += 1
      sink = input.events!
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquires,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        acquisitionGeneration: `generation-${acquires}`,
        link: {
          linkId: `link-${acquires}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: acquires === 1 ? 'created' : 'resumed',
          handle: codexProviderHandle(THREAD)
        }
      }
    },
    dispatch,
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => {},
    setOption: async () => {},
    rewindSupport,
    rewind,
    recoverRewind,
    releaseAcquisition: async () => true,
    closeSession: async () => true
  }
}

function openHost(): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    agents: claudeAndCodexDeclared(),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' }),
    idleSweep: { intervalMs: 3_600_000 }
  })
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquires = 0
  rewind.mockReset()
  recoverRewind.mockReset().mockResolvedValue({
    ok: true,
    items: [{ identity: KEPT, body: hostTestMessage('verified history') }]
  })
  rewindSupport.mockReset().mockReturnValue({ supported: true })
  dispatch.mockReset().mockImplementation(async (input): Promise<AgentSessionDispatchOutcome> => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: THREAD,
      turnId: input.clientMessageId,
      ordinal: 1
    }
  }))
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-live-'))
  store = await openTestAgentSessionRecordStore(directory)
  host = openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

function fence(): number {
  return store.getRecord(SESSION)!.lease.runtimeFence
}

function rewindParams(itemId: string, expectedEpoch: string) {
  return {
    itemId,
    expectedEpoch,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: SESSION,
        fields: { itemId, expectedEpoch }
      })
    }
  }
}

function sendParams(text: string, clientOperationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  return {
    body,
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    }
  }
}

/** A rewind whose provider call threw while the agent stays running. */
async function rewindInDoubtWithLiveChild(): Promise<void> {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const drop = { ...KEPT, turnId: 'drop' }
  sink.appendItem(KEPT, hostTestMessage('verified history'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  sink.appendItem(drop, hostTestMessage('to be rewound'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await host.flushStreamedEvents(SESSION)
  rewind.mockRejectedValue(new Error('provider reply lost'))
  const epoch = (await host.journalSnapshot(SESSION)).cursor.epoch
  await expect(host.rewind(caller, rewindParams(agentJournalItemKey(drop), epoch))).rejects.toThrow(
    'provider reply lost'
  )
  expect(store.getRecord(SESSION)?.rewind).toMatchObject({ phase: 'prepared' })
  expect(host.hasSession(SESSION)).toBe(true)
}

function sentTexts(items: readonly AgentJournalRenderItem[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'message'
      ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

describe('a rewind in doubt while its agent keeps running', () => {
  it('is settled by the next send, which is then delivered', async () => {
    await rewindInDoubtWithLiveChild()
    const before = acquires

    expect(await host.send(caller, sendParams('after the rewind'))).toMatchObject({ ok: true })
    expect(acquires).toBe(before)
    expect(recoverRewind).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(sentTexts((await host.journalSnapshot(SESSION)).items)).toEqual([
      'verified history',
      'after the rewind'
    ])
  })

  it('lets the send through when the provider proves the rewind never happened', async () => {
    await rewindInDoubtWithLiveChild()
    recoverRewind.mockResolvedValueOnce({ ok: false, reason: 'provider-refused' })

    expect(await host.send(caller, sendParams('after the refused rewind'))).toMatchObject({
      ok: true
    })
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('refused')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  })

  it('refuses the send while recovery stays unknown, and decides its Retry afresh once settled', async () => {
    await rewindInDoubtWithLiveChild()
    recoverRewind.mockResolvedValueOnce({ ok: false, reason: 'outcome-unknown' })
    const id = hostTestOperationId()

    expect(await host.send(caller, sendParams('typed during the doubt', id))).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        details: { reason: 'rewindUnconfirmed', rewindReason: 'outcome-unknown' }
      }
    })
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('prepared')
    expect(dispatch).not.toHaveBeenCalled()

    // The Retry keeps the id; the provider now answers, so the same id is sent.
    expect(await host.send(caller, sendParams('typed during the doubt', id))).toMatchObject({
      ok: true,
      replayed: false
    })
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  })

  it('leaves /clear its own settled refusal: nothing ran, and it mints a fresh id per attempt', async () => {
    await rewindInDoubtWithLiveChild()
    recoverRewind.mockResolvedValue({ ok: false, reason: 'outcome-unknown' })
    const result = await host.conversationCommand(caller, {
      command: 'clear',
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command: 'clear' }
        })
      }
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
  })
})
