// A session that published and then lost its child before startup (not signed in, say) keeps a
// released lease and a chat the user can still type into. The send is the user asking for the
// child back: the host restarts it before admitting the write and delivers against the new owner,
// instead of parking the message behind a lease nothing would ever re-acquire.
//
// A child is published before it has proven its start, and it owns the send from that moment: the
// message is admitted against it and the adapter holds it for the start. When the child exits
// first, the exit settlement rejects the message and writes the cause into the chat, once, and
// the next send is a fresh restart.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestLaunchDirectory,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
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

/** A send is admitted against the child it meets, proven or not; the adapter holds the rest. */
async function send(
  text: string,
  fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: sendEnvelope(fence, body), body })
  expect(sent, JSON.stringify(sent)).toMatchObject({
    ok: true,
    replayed: false,
    value: { submission: { dispatchState: 'pending' } }
  })
  return sent.ok ? sent.value.clientMessageId : ''
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
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

function journalStatuses(): string[] {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

function submission(clientMessageId: string) {
  return host
    .journalSnapshot(SESSION)
    .submissions.find((entry) => entry.clientMessageId === clientMessageId)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-after-failed-start-'))
  resetHostTestOperationIds()
  generation = 0
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      // A re-acquire resumes the thread the first child minted, as a real adapter does.
      origin: generation === 0 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: `generation-${++generation}`,
    providerChildPhase: 'starting' as const
  }))
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
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
    journalRoot: root,
    claimKeyId: 'key-1',
    resolveLaunchDirectory: hostTestLaunchDirectory,
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

    // The client was current as of the lost owner, so the send is rebased onto the fence the
    // resume published and admitted once, with no stale round trip.
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

  it('retires the held message with the cause when the restarted child exits before proving its start', async () => {
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const rowsBefore = journalStatuses().length

    const held = await send('still not signed in', releasedFence)
    await exitBeforeProof()

    // The child never proved its start, so it accepted nothing: the exit rejects the message this
    // host admitted, so nothing pins the session and Retry stays offered, and one row names the cause.
    expect(submission(held)).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining(EXIT_REASON),
      recovered: true
    })
    expect(
      host.journalSnapshot(SESSION).submissions.filter((e) => e.dispatchState === 'pending')
    ).toEqual([])
    expect(journalStatuses().slice(rowsBefore)).toEqual([
      expect.stringMatching(/stopped before it finished starting: .*not signed in/)
    ])
    // The failed restart moved the fence twice: the acquisition, and the exit that released it.
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(releasedFence + 2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    // One spawn per user action: nothing restarted it a second time.
    expect(acquire).toHaveBeenCalledTimes(2)

    // Retry is a fresh action: it restarts once and is admitted against the new child.
    await send('signed in now')
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(journalStatuses().slice(rowsBefore)).toHaveLength(1)
  })
})

describe('a send while the child of the first start is still proving itself', () => {
  it('is admitted against the starting child, and nothing restarts it', async () => {
    await send('hello')

    expect(dispatch).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()

    await proveStarted()

    expect(acquire).toHaveBeenCalledOnce()
    expect(journalStatuses()).toEqual([])
  })

  it('is retired with the cause when that child exits first, and restarts nothing', async () => {
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const held = await send('hello')

    await exitBeforeProof()

    expect(submission(held)).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining(EXIT_REASON),
      recovered: true
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(journalStatuses()).toEqual([
      expect.stringMatching(/stopped before it finished starting: .*not signed in/)
    ])
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence + 1)
  })

  it('leaves a send against a proven child alone', async () => {
    await proveStarted()

    await send('hello')

    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
