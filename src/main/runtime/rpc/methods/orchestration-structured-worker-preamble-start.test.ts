// A structured worker's preamble is its first message, which starts its agent. What the dispatch
// is told about that start, read from a real host: ready, failed at the preamble, or unknown while a
// start is still being retried.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { mintAgentSessionOperationId } from '../../orchestration/structured-pointer-operation-id'
import { sendStructuredWorkerPreamble } from './orchestration-structured-worker-session'
import { structuredPreambleTurnStart } from './orchestration/worker/deliver-worker-dispatch-preamble'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'

let root: string
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let clock: number

const accountSwitch = () =>
  new AgentSessionPreSpawnError(new Error('switching'), { reason: 'accountSwitchInProgress' })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-worker-preamble-start-'))
  clock = Date.now()
  const store = await openTestAgentSessionRecordStore(root)
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: clock, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: clock
    }
  }))
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      supportsCreate: () => true,
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: vi.fn(async ({ clientMessageId }) => ({
        state: 'accepted' as const,
        providerIdentity: {
          provider: 'codex' as const,
          threadId: THREAD,
          turnId: `turn-${clientMessageId}`,
          ordinal: 1
        }
      })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => clock
  })
  const create = hostTestAttachParams(null)
  // On the host's clock: the preamble's own operation ids are minted from it too.
  create.envelope.clientOperationId = mintAgentSessionOperationId(clock)
  expect(await host.create({ callerKey: 'client-1' }, create)).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendPreamble(budgetMs: number) {
  return sendStructuredWorkerPreamble({
    host,
    sessionId: SESSION,
    dispatchId: 'dispatch-1',
    preamble: 'You are a worker.',
    budgetMs
  })
}

describe('a structured worker preamble that starts its agent', () => {
  it('is ready once the agent takes it', async () => {
    const delivery = await sendPreamble(5_000)

    expect(delivery).toEqual({ state: 'accepted' })
    expect(structuredPreambleTurnStart(delivery)).toEqual({ verdict: 'observed' })
  })

  it('fails at the preamble when the start is refused for the person to fix', async () => {
    acquire.mockRejectedValueOnce(
      new AgentSessionAcquisitionRefusal('not signed in', 'notSignedIn')
    )

    await expect(sendPreamble(5_000)).rejects.toMatchObject({
      code: 'dispatch_preamble_undelivered'
    })
  })

  it('keeps waiting across a retried start, and is ready when the retry takes it', async () => {
    acquire.mockRejectedValueOnce(accountSwitch())
    const delivery = sendPreamble(5_000)
    await vi.waitFor(async () =>
      expect((await host.journalSnapshot(SESSION)).submissions[0]?.startRetry).toBeDefined()
    )

    // The retry comes due; the delivery loop takes it on its next wake.
    clock += 15_000
    host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)

    expect(await delivery).toEqual({ state: 'accepted' })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('reads unknown, with the start failure, while a start is still retried at the budget', async () => {
    acquire.mockRejectedValue(accountSwitch())

    const delivery = await sendPreamble(200)

    expect(delivery).toMatchObject({ state: 'pending', startRetry: { attempts: 1 } })
    expect(structuredPreambleTurnStart(delivery)).toEqual({
      verdict: 'unobserved',
      reason: expect.stringMatching(
        /^The worker's agent did not start: .+ The dispatch preamble waits for its next start;/
      )
    })
    expect(acquire).toHaveBeenCalledOnce()
  })
})
