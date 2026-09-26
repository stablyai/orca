import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// A Codex rewind whose outcome only the provider can prove, found on a chat at rest: nothing on
// screen will start the agent that settles it, so the next send does, and its message is kept.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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
          handle: { provider: 'codex', threadId: THREAD }
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
    store,
    adapter: adapter(),
    journalRoot: directory,
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
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-rest-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
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

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return {
    body,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    }
  }
}

/** A chat whose rewind the provider applied, whose Orca side never finished, reopened at rest. */
async function interruptedRewindAtRest(): Promise<void> {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const drop = { ...KEPT, turnId: 'drop' }
  sink.appendItem(KEPT, hostTestMessage('verified history'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  sink.appendItem(drop, hostTestMessage('to be rewound'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await host.flushStreamedEvents(SESSION)
  rewind.mockImplementation(async (input) => {
    await input.onReverted?.()
    throw new Error('history unavailable')
  })
  const epoch = (await host.journalSnapshot(SESSION)).cursor.epoch
  await expect(host.rewind(caller, rewindParams(agentJournalItemKey(drop), epoch))).rejects.toThrow(
    'history unavailable'
  )
  expect(store.getRecord(SESSION)?.rewind).toMatchObject({ phase: 'prepared' })
  await host.flushAllStreamedEvents()
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  host = openHost()
}

describe('an interrupted Codex rewind on a chat at rest (R16)', () => {
  it('is settled by the start a send makes, and the message is delivered after it', async () => {
    await interruptedRewindAtRest()
    expect(host.hasSession(SESSION)).toBe(false)
    const before = acquires

    const sent = await host.send(caller, sendParams('after the rewind'))
    expect(sent).toMatchObject({ ok: true })
    expect(acquires - before).toBe(1)
    expect(recoverRewind).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    const snapshot = await host.journalSnapshot(SESSION)
    const texts = snapshot.items.flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    // The recovered history, then the new message — nothing the rewind dropped, nothing lost.
    expect(texts).toEqual(['verified history', 'after the rewind'])
    expect(snapshot.submissions.at(-1)?.dispatchState).toBe('accepted')
  })
})

describe('a rewind asked of a chat at rest (P2-23)', () => {
  it('starts the agent first and answers with what the provider says', async () => {
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    sink.appendItem(KEPT, hostTestMessage('kept'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await host.flushStreamedEvents(SESSION)
    const epoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({
      directory: join(directory, 'store'),
      hostId: 'local'
    })
    host = openHost()
    const before = acquires
    rewindSupport.mockReturnValue({ supported: false, reason: 'history-not-paginated' })

    const result = await host.rewind(caller, rewindParams(agentJournalItemKey(KEPT), epoch))
    expect(acquires - before).toBe(1)
    expect(result).toMatchObject({ ok: false, refusal: { rewindReason: 'history-not-paginated' } })
    expect(rewind).not.toHaveBeenCalled()
  })
})
