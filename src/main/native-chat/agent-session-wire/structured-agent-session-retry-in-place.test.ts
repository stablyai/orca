// The person's Retry of a message whose agent never took it queues that same message again: one
// id, one bubble, one delivery, however many presses, from however many devices.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
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

const CALLER = { callerKey: 'client-1' }
const PHONE = { callerKey: 'phone-1' }

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
// Runs before each spawn; throwing refuses that start.
let beforeSpawn = vi.fn<() => Promise<void>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let completions: AgentSessionTurnCompletionEvent[] = []

function startHost(): void {
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        await beforeSpawn()
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            // A start after the first continues the chain it created.
            origin: store.getRecord(SESSION)?.providerHandleChain.length
              ? ('resumed' as const)
              : ('created' as const),
            mintedAtFence: fence,
            observedAt: NOW
          },
          acquisitionGeneration: `generation-${fence}`
        }
      }),
      releaseAcquisition: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${beforeSpawn.mock.calls.length + 1}`,
    now: () => NOW,
    // A booked try never fires on its own here: a test that wants one presses Retry.
    setStartRetryTimer: () => () => {}
  })
  host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })
}

function notInstalled(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error('codex not installed'), {
    reason: 'providerMissing',
    needsUser: true
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-retry-in-place-'))
  resetHostTestOperationIds()
  completions = []
  beforeSpawn = vi.fn(async () => undefined)
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(
    host.attach(CALLER, hostTestAttachParams(null, { providerHandle: undefined }))
  ).resolves.toMatchObject({ ok: true })
  // The chat is put to rest, so each message starts the agent.
  await host.close(SESSION, 'evict')
  dispatch.mockClear()
  beforeSpawn.mockClear()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function fence(): number {
  return store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body,
    userSend: true
  })
  expect(sent).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

function retry(
  clientMessageId: string,
  caller = CALLER,
  clientOperationId = hostTestOperationId()
) {
  return host.retryMessage(caller, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.retryMessage',
        sessionId: SESSION,
        fields: { clientMessageId }
      })
    },
    clientMessageId
  })
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function failures(): number {
  return completions.filter(
    (event) => event.type === 'completion' && event.completion.outcome === 'failure'
  ).length
}

/** A message whose start failed for good: rejected, no agent ever took it. */
async function failedForGood(text: string): Promise<string> {
  beforeSpawn.mockRejectedValueOnce(notInstalled())
  const id = await send(text)
  await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
  return id
}

describe('a Retry of a message whose start failed for good', () => {
  it('queues that same message again, and it is delivered once, under its own id', async () => {
    const id = await failedForGood('hello')

    await expect(retry(id)).resolves.toMatchObject({ ok: true, value: { clientMessageId: id } })

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([id])
    )
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.submissions.map((entry) => entry.clientMessageId)).toEqual([id])
    expect(await submission(id)).not.toHaveProperty('rejection')
  })

  it('sends nothing more for a second press, its replay, or the phone pressing at once', async () => {
    const id = await failedForGood('hello')
    const operation = hostTestOperationId()

    await Promise.all([retry(id, CALLER, operation), retry(id, PHONE)])
    await retry(id, CALLER, operation)
    await retry(id)

    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await host.flushStreamedEvents(SESSION)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('notifies again when it fails again, at its new end, and not in between', async () => {
    const id = await failedForGood('hello')
    await eventually(() => expect(failures()).toBe(1))

    beforeSpawn.mockRejectedValueOnce(notInstalled())
    await retry(id)

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    await eventually(() => expect(failures()).toBe(2))
    expect(await submission(id)).toMatchObject({
      rejection: agentSessionFailureFact('providerMissing')
    })
  })

  it('answers as it stands for a message an agent already took, and sends nothing', async () => {
    const id = await send('hello')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))

    await expect(retry(id)).resolves.toMatchObject({ ok: true, value: { clientMessageId: id } })

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('is refused for a message the chat does not hold', async () => {
    await expect(retry(`${NOW}-${'e'.repeat(32)}`)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
  })
})

// The usual way Retry is used: the message failed, the person fixed something, and came back later.
// By then the chat was put to rest, Orca restarted, or the chat was closed while it waited.
describe('a Retry after the chat it failed in was closed or reopened', () => {
  async function reopen(): Promise<void> {
    await expect(
      host.attach(CALLER, hostTestAttachParams(fence(), { providerHandle: undefined }))
    ).resolves.toMatchObject({ ok: true })
  }

  it('delivers it after the idle sweep put the chat to rest', async () => {
    const id = await failedForGood('hello')
    await host.close(SESSION, 'evict')

    await expect(retry(id)).resolves.toMatchObject({ ok: true })

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([id])
    )
  })

  it('delivers it after Orca restarted', async () => {
    const id = await failedForGood('hello')
    await host.flushAllStreamedEvents()
    startHost()
    await host.journalSnapshot(SESSION)

    await expect(retry(id)).resolves.toMatchObject({ ok: true })

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([id])
    )
    expect(await submission(id)).not.toHaveProperty('rejection')
  })

  it('delivers one whose wait the chat closing ended, once it is open again', async () => {
    beforeSpawn.mockRejectedValueOnce(
      new AgentSessionPreSpawnError(new Error('switching'), { reason: 'accountSwitchInProgress' })
    )
    const id = await send('hello')
    await eventually(async () => expect((await submission(id))?.startRetry).toBeDefined())
    await host.close(SESSION, 'user-close')
    await eventually(async () =>
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        rejectionCause: 'chatClosed'
      })
    )
    await reopen()

    await expect(retry(id)).resolves.toMatchObject({ ok: true })

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([id])
    )
  })
})
