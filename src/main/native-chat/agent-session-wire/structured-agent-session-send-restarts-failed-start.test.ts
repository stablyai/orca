// A session that published and then lost its child before startup (not signed in, say) keeps a
// released lease and a chat the user can still type into. The send is the user asking for the
// child back: the host accepts the message, and its delivery restarts the child and hands the
// message to the new owner, instead of parking it behind a lease nothing would ever re-acquire.
//
// A child is published before it has proven its start, and it owns the send from that moment: the
// message is handed to it. When the child exits first, the exit settlement rejects the message with
// the cause on it, and the next send is a fresh restart.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
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
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const CALLER = { callerKey: 'client-1' }

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let generation = 0

function sendEnvelope(
  fence: number,
  body: ReturnType<typeof hostTestMessage>
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
}

/** A send is accepted at once and handed to the child delivery finds or starts. */
async function send(
  text: string,
  fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: sendEnvelope(fence, body), body })
  expect(sent, JSON.stringify(sent)).toMatchObject({
    ok: true,
    replayed: false,
    value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
  })
  const clientMessageId = sent.ok ? sent.value.clientMessageId : ''
  await eventually(async () =>
    expect((await submission(clientMessageId))?.handedOverAt).toBeDefined()
  )
  return clientMessageId
}

/** The child of the current acquisition, as the adapter would identify it in a lifecycle event. */
function currentChild() {
  return {
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`
  }
}

function proveStarted(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'started',
    ...currentChild(),
    reportedOptions: { model: 'sonnet' },
    restoreSkippedOptions: []
  })
}

function exitBeforeProof(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    ...currentChild(),
    reason: EXIT_REASON,
    failure: { kind: 'providerExited', detail: { text: EXIT_REASON, audience: 'log' } },
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

const STARTUP_FAILURE = {
  kind: 'providerStartFailed',
  detail: { text: EXIT_REASON, audience: 'log' }
}

async function journalStatuses(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

async function submission(clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-after-failed-start-'))
  resetHostTestOperationIds()
  generation = 0
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      // A re-acquire resumes the thread the first child minted, as a real adapter does.
      origin: generation === 0 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: `generation-${++generation}`,
    providerChildPhase: 'starting' as const
  }))
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${generation + 1}`,
    now: () => NOW
  })
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a send into a published session whose child ended before startup', () => {
  beforeEach(async () => {
    await exitBeforeProof()
    // The failed start released the lease and no resume ran on its own.
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('restarts the child and admits the message against it before it has proven its start', async () => {
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await send('hello again', releasedFence)

    // Accepted at the lost owner's fence and handed to the child delivery started, once.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(dispatch).toHaveBeenCalledOnce()
    const current = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    expect(current).toBeGreaterThan(releasedFence)

    // Once proven, the next send meets a live owner and restarts nothing.
    await proveStarted()
    await send('and again', current)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('rejects the held message with the cause when the restarted child exits before proving its start', async () => {
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const rowsBefore = (await journalStatuses()).length

    const held = await send('still not signed in', releasedFence)
    await exitBeforeProof()

    // The child never proved its start, so it accepted nothing: the message is rejected at once with
    // the cause on it, no later try is booked, and the chat gets no row of its own for it.
    await vi.waitFor(async () =>
      expect(await submission(held)).toMatchObject({
        dispatchState: 'rejected',
        reason: 'Codex stopped before it finished starting. Send your message to try again.',
        rejection: STARTUP_FAILURE
      })
    )
    expect((await submission(held))?.startRetry).toBeUndefined()
    expect((await journalStatuses()).slice(rowsBefore)).toEqual([])
    // The failed restart moved the fence twice: the acquisition, and the exit that released it.
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(releasedFence + 2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    // One spawn per user action: nothing restarted it a second time.
    expect(acquire).toHaveBeenCalledTimes(2)

    // A new message is a fresh action: it restarts once and is handed to the new child.
    await send('signed in now')
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect((await journalStatuses()).slice(rowsBefore)).toEqual([])
  })
})

describe('a send while the child of the first start is still proving itself', () => {
  it('is handed to the starting child, and nothing restarts it', async () => {
    await send('hello')

    expect(dispatch).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()

    await proveStarted()

    expect(acquire).toHaveBeenCalledOnce()
    expect(await journalStatuses()).toEqual([])
  })

  it('is rejected with the cause when that child exits first, and restarts nothing', async () => {
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const held = await send('hello')

    await exitBeforeProof()

    await vi.waitFor(async () =>
      expect(await submission(held)).toMatchObject({
        dispatchState: 'rejected',
        reason: 'Codex stopped before it finished starting. Send your message to try again.',
        rejection: STARTUP_FAILURE
      })
    )
    expect((await submission(held))?.startRetry).toBeUndefined()
    expect(acquire).toHaveBeenCalledOnce()
    expect(await journalStatuses()).toEqual([])
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence + 1)
  })

  it('leaves a send against a proven child alone', async () => {
    await proveStarted()

    await send('hello')

    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
