// A session that published and then lost its child before startup (not signed in, say) keeps a
// released lease and a chat the user can still type into. The send is the user asking for the
// child back: the host accepts the message, and its delivery restarts the child and hands the
// message to the new owner, instead of parking it behind a lease nothing would ever re-acquire.
//
// A child is published before it has proven its start, and the host holds the send until it does,
// then hands it over. When the child exits first, the message was never handed over: it is rejected
// with the cause, written into the chat once, and the next send is a fresh restart.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
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
  hostTestDrawnRowIds,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

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

/** A send is accepted at once; delivery finds or starts its child and holds it until that child
 *  proves its start. */
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
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  return clientMessageId
}

async function handedOver(clientMessageId: string): Promise<void> {
  await eventually(async () =>
    expect((await submission(clientMessageId))?.handedOverAt).toBeDefined()
  )
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
    restoreSkippedOptions: [],
    optionRevision: host.collaboratorsForTests().runtimeState.optionRevisions.current(SESSION)
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
    agents: NO_STRUCTURED_AGENTS,
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

  it('restarts the child and holds the message for it until it proves its start', async () => {
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    const first = await send('hello again', releasedFence)

    // Accepted at the lost owner's fence, held for the child delivery started.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(dispatch).not.toHaveBeenCalled()
    const current = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    expect(current).toBeGreaterThan(releasedFence)

    // Proven, the child is handed the message, once.
    await proveStarted()
    await handedOver(first)
    expect(dispatch).toHaveBeenCalledOnce()

    // The next send meets a live owner and restarts nothing. The child echoes the first message,
    // as a live one does, so the next is not held behind a turn still opening.
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: first,
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
    })
    await handedOver(await send('and again', current))
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('retires the held message with the cause when the restarted child exits before proving its start', async () => {
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const rowsBefore = (await journalStatuses()).length

    const held = await send('still not signed in', releasedFence)
    await exitBeforeProof()

    // The child never proved its start, so it was handed nothing: the message is rejected, so
    // nothing pins the session and Retry stays offered, and one row names the cause.
    await eventually(async () => expect((await submission(held))?.dispatchState).toBe('rejected'))
    expect((await submission(held))?.handedOverAt).toBeUndefined()
    expect(await submission(held)).toMatchObject({
      dispatchState: 'rejected',
      reason: 'Codex stopped before it finished starting. Send your message to try again.',
      rejection: STARTUP_FAILURE,
      recovered: true
    })
    expect(
      (await host.journalSnapshot(SESSION)).submissions.filter((e) => e.dispatchState === 'pending')
    ).toEqual([])
    expect((await journalStatuses()).slice(rowsBefore)).toEqual([
      'Codex stopped before it finished starting. Send your message to try again.'
    ])
    // Accepted before the restart it needed, so the chat draws it above the row naming the cause.
    const snapshot = await host.journalSnapshot(SESSION)
    const causeRow = snapshot.items.findLast((item) => item.body.kind === 'status')?.itemId
    const shown = [agentJournalSubmissionKey(held), causeRow]
    expect(
      hostTestDrawnRowIds(snapshot, [
        { clientMessageId: held, text: 'still not signed in' }
      ]).filter((id) => shown.includes(id))
    ).toEqual(shown)
    // The failed restart moved the fence twice: the acquisition, and the exit that released it.
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(releasedFence + 2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    // One spawn per user action: nothing restarted it a second time.
    expect(acquire).toHaveBeenCalledTimes(2)

    // Retry is a fresh action: it restarts once and is handed to the new child once it proves itself.
    const retry = await send('signed in now')
    expect(acquire).toHaveBeenCalledTimes(3)
    await proveStarted()
    await handedOver(retry)
    expect(dispatch).toHaveBeenCalledOnce()
    expect((await journalStatuses()).slice(rowsBefore)).toHaveLength(1)
  })
})

describe('a send while the child of the first start is still proving itself', () => {
  it('is held for the starting child, handed over once it proves its start, and restarts nothing', async () => {
    const id = await send('hello')

    expect(dispatch).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledOnce()

    await proveStarted()

    await handedOver(id)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()
    expect(await journalStatuses()).toEqual([])
  })

  it('is retired with the cause when that child exits first, and restarts nothing', async () => {
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const held = await send('hello')

    await exitBeforeProof()

    await eventually(async () => expect((await submission(held))?.dispatchState).toBe('rejected'))
    expect(await submission(held)).toMatchObject({
      dispatchState: 'rejected',
      reason: 'Codex stopped before it finished starting. Send your message to try again.',
      rejection: STARTUP_FAILURE,
      recovered: true
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(await journalStatuses()).toEqual([
      'Codex stopped before it finished starting. Send your message to try again.'
    ])
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence + 1)
  })

  it('leaves a send against a proven child alone', async () => {
    await proveStarted()

    await handedOver(await send('hello'))

    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
