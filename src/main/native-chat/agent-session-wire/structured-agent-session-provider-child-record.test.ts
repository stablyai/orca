// The provider child is its own record on the conversation: stopping it, losing it or failing to
// start it ends the child, never the conversation. Against the real host, store and journal, with a
// live subscriber opened before each action.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusSummary,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let adapterExtras: Partial<StructuredAgentSessionAdapter>

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function generation(): string {
  return `generation-${acquire.mock.calls.length}`
}

const spawnChild: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: generation(),
  link: {
    linkId: `link-${fence}`,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: store.getRecord(SESSION)?.providerHandleChain.length
      ? ('resumed' as const)
      : ('created' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
})

/** A Claude-shaped child: published at spawn, so it is `starting` until `started`. */
const spawnStartingChild: StructuredAgentSessionAdapter['acquire'] = async (input) => ({
  ...(await spawnChild(input)),
  providerChildPhase: 'starting' as const
})

function startHost(): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    releaseGraceMs: 60_000,
    now: () => NOW
  })
}

async function restartHost(): Promise<void> {
  await host.flushAllStreamedEvents()
  startHost()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-child-record-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  acquire = vi.fn(spawnChild)
  dispatch = vi.fn(async (input) => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${input.clientMessageId}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await host.close(SESSION)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function accept(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
  return clientOperationId
}

function stop() {
  const turnId = 'turn-none'
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: { turnId }
      })
    },
    turnId
  })
}

function submission(id: string): AgentJournalSubmission | undefined {
  return host.journalSnapshot(SESSION).submissions.find((entry) => entry.clientMessageId === id)
}

function statusRows(): { text: string; tone?: string }[] {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) =>
      item.body.kind === 'status'
        ? [{ text: item.body.text, ...(item.body.tone ? { tone: item.body.tone } : {}) }]
        : []
    )
}

function conversation() {
  return host['sessions'].get(SESSION)
}

function subscribe(): AgentSessionSubscribeEvent[] {
  const events: AgentSessionSubscribeEvent[] = []
  host.subscribe({
    id: 'sub-1',
    sessionId: SESSION,
    emit: (event) => events.push(structuredClone(event))
  })
  return events
}

/** The chat's status row as a session list sees it, frame by frame. */
function watchStatus(): AgentSessionStatusSummary[] {
  const frames: AgentSessionStatusSummary[] = []
  host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        frames.push(event.session)
      }
    }
  })
  return frames
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('Stop on a child still proving its start', () => {
  it('ends the child and keeps the conversation, its holders and its readers (R1)', async () => {
    const ended = deferred<void>()
    adapterExtras = {
      awaitStarted: vi.fn(() => ended.promise),
      closeSession: vi.fn(async () => {
        ended.resolve()
        return true
      })
    }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    await host.hold(SESSION, 'surface-1', { resume: false })
    const first = await accept('hello')
    const journal = conversation()?.journal
    const events = subscribe()
    const frames = watchStatus()
    await eventually(() => expect(conversation()?.child?.phase).toBe('starting'))

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    // The same conversation: no reopen, the holder kept, and the chat told it is idle again.
    expect(conversation()?.journal).toBe(journal)
    expect(conversation()?.child).toBeNull()
    expect(host.isHeld(SESSION)).toBe(true)
    expect(frames.at(-1)).not.toHaveProperty('hostExecutionPhase')
    expect(frames.at(-1)).not.toHaveProperty('hostExecutionOwned')
    expect(submission(first)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    // A Stop is not a failure: no row, and the loop is gone.
    expect(statusRows()).toEqual([])
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))

    const next = await accept('after stop')
    await eventually(() => expect(submission(next)?.dispatchState).toBe('accepted'))
    expect(conversation()?.journal).toBe(journal)
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([next])
    // The reader opened before the Stop saw the next message delivered on the same stream.
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.submissions.some(
            (entry) => entry.clientMessageId === next && entry.dispatchState === 'accepted'
          )
      )
    ).toBe(true)
  })
})

describe('a settlement retry for an earlier child inside the attach for the next one', () => {
  it('settles the earlier child and leaves the queued message to the new child (R1)', async () => {
    // The earlier child's settlement is still owed; the lease is otherwise released.
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        settlementRetryRequired: true,
        settlementRetryId: `provider-exit:${SESSION}:1:generation-1`
      }
    }))
    const retryFence = store.getRecord(SESSION)!.lease.runtimeFence
    const id = await accept('for the next child')

    await eventually(() => expect(submission(id)?.dispatchState).toBe('accepted'))
    expect(store.getRecord(SESSION)?.lease.settlementRetryRequired).toBeUndefined()
    // Handed over at the new child's fence, which the attach reserved after the retry.
    const newFence = store.getRecord(SESSION)!.lease.runtimeFence
    expect(newFence).toBeGreaterThan(retryFence)
    expect(submission(id)?.fence).toBe(newFence)
    expect(conversation()?.child).toMatchObject({ generation: generation(), fence: newFence })
  })
})
