// A Stop that names no turn stops what the conversation has in flight: it withdraws what is
// queued, and interrupts a handed-over message even before the provider has opened its turn —
// the gap no client can name a turn for. Against the real host, store and journal.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { CancelParams } from '../../../shared/rpc-contract/structured-agent-session-params'
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
const ALREADY_FINISHED = 'The provider had already finished this turn.'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let awaitStarted: Mock<NonNullable<StructuredAgentSessionAdapter['awaitStarted']>>

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-conversation-stop-'))
  resetHostTestOperationIds()
  // Admitted, not accepted: the message is written and its turn has not opened.
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  awaitStarted = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        acquisitionGeneration: 'generation-1',
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      dispatch,
      awaitStarted,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn,
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function send(text: string) {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const result = host.send(CALLER, {
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
  return { id: clientOperationId, result }
}

function stop(turnId?: string, clientOperationId = hostTestOperationId()) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

async function statusRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

describe('a Stop that names no turn', () => {
  it('is a valid cancel, and only a plain Stop may omit the turn', () => {
    const envelope = {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: '0'.repeat(64)
    }
    expect(CancelParams.safeParse({ envelope }).success).toBe(true)
    expect(
      CancelParams.safeParse({ envelope, prompt: { itemId: 'item-1', expectedRevision: 1 } })
        .success
    ).toBe(false)
    expect(CancelParams.safeParse({ envelope, scope: 'background-tasks' }).success).toBe(false)
  })

  it('interrupts a handed-over message before its turn opens, as a cancellation', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    expect(
      (await host.journalSnapshot(SESSION)).items.some((item) => item.body.kind === 'turn')
    ).toBe(false)

    const stopped = await stop()

    expect(stopped).toEqual({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: expect.anything(),
      value: { cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    expect(cancelTurn.mock.calls[0]![0]).not.toHaveProperty('turnId')
    expect(cancelTurn.mock.calls[0]![0]).toMatchObject({ sessionId: SESSION, fence: 1 })
    expect(await statusRows()).toEqual(['Cancellation requested.'])
    // Nothing is owed the interrupted send any more: settled in doubt, so the chat reads idle.
    expect(await submission(id)).toMatchObject({
      dispatchState: 'unknown',
      reason: 'stopped_before_acknowledgement',
      recovered: true
    })
  })

  it('withdraws what is queued on a ready child and asks the provider for nothing more', async () => {
    const started = Promise.withResolvers<undefined>()
    awaitStarted.mockImplementationOnce(() => started.promise)
    const { id, result } = send('hello')
    await result
    await eventually(() => expect(awaitStarted).toHaveBeenCalled())

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    started.resolve(undefined)

    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    await host.flushStreamedEvents(SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })

  it('withdraws a send still on its way in, which the host takes first', async () => {
    const { id, result } = send('hello')
    const stopped = stop()

    expect(await result).toMatchObject({ ok: true })
    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    await host.flushStreamedEvents(SESSION)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('says the agent did not stop, in its words, when it refused', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'no active turn to interrupt', audience: 'person' } }
    })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(await statusRows()).toEqual(["Codex didn't stop: no active turn to interrupt."])
  })

  it('says the Stop is unconfirmed, not that nothing ran, when the provider took it', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    cancelTurn.mockResolvedValueOnce({ cancelled: false, unconfirmed: true })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(await statusRows()).toEqual(['Cancellation was not confirmed.'])
  })

  it('says the agent had no turn to stop when it had none', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(await statusRows()).toEqual(['Codex had no turn running to stop.'])
  })

  it('stops nothing when it reuses the id of a Stop the host already ran', async () => {
    const operationId = hostTestOperationId()
    expect(await stop(undefined, operationId)).toMatchObject({ ok: true, replayed: false })
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())

    // Why the client never reuses a no-turn Stop's id: the same id is the same Stop.
    expect(await stop(undefined, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('is a quiet no-op with nothing in flight', async () => {
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })
})

describe('a Stop that names its turn, as an older client sends it', () => {
  it('reaches the provider with that turn and keeps its not-cancelled note', async () => {
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stop('turn-1')).toMatchObject({
      ok: true,
      value: { turnId: 'turn-1', cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-1' }))
    expect(await statusRows()).toEqual([ALREADY_FINISHED])
  })
})
