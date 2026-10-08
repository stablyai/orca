// A start that fails can be written up twice: by the exit settlement, for a message the starting
// child was handed, and by the delivery loop, for a message the exit found still queued. The chat
// gets one row for that start, in the words the message was rejected with.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
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
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'
// The exit's reason is Orca's log text; the row says only that the start stopped.
const EXIT_TEXT = 'Codex stopped before it finished starting. Send your message to try again.'
// The first child (generation-1) is lost at setup; the send starts generation-2.
const START_ROW = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'start-failure:generation-2'
})

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let generation = 0
/** The next start's child exits as its start step returns, before the handover step. */
let exitOnStart = false
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let frames: AgentSessionSubscribeEvent[] = []

function exitBeforeProof(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true })
  await eventually(() => expect(generation).toBe(2))
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

/** Every text the subscriber was sent for the start's row, in order. */
function publishedStartRows(): string[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.items.flatMap((item) =>
          item.itemId === START_ROW && item.body.kind === 'status' ? [item.body.text] : []
        )
      : []
  )
}

async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.itemId === START_ROW && item.body.kind === 'status' ? [item.body.text] : []
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  frames = []
  exitOnStart = false
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        const child = {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: generation === 0 ? ('created' as const) : ('resumed' as const),
            mintedAtFence: fence,
            observedAt: NOW
          },
          acquisitionGeneration: `generation-${++generation}`,
          providerChildPhase: 'starting' as const
        }
        if (exitOnStart) {
          // Asked for on the lane while the start step runs, so it lands before the handover.
          void host.handleAdapterEvent({
            type: 'ended',
            sessionId: SESSION,
            fence,
            acquisitionGeneration: child.acquisitionGeneration,
            reason: EXIT_REASON,
            cause: 'unexpected-exit',
            startupUnproven: true
          })
        }
        return child
      }),
      releaseAcquisition: vi.fn(async () => true),
      closeSession: vi.fn(async () => true),
      dispatch: (...args) => dispatch(...args),
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
  await exitBeforeProof()
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a start that fails before it proves itself', () => {
  it("writes one row in the exit's words for a message the child was handed", async () => {
    const sent = await send('hello')
    // A starting child takes the message at once.
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())

    await exitBeforeProof()
    await eventually(async () =>
      expect(await submission(sent)).toMatchObject({ dispatchState: 'rejected', reason: EXIT_TEXT })
    )
    await host.flushStreamedEvents(SESSION)

    expect(await startRows()).toEqual([EXIT_TEXT])
    expect(publishedStartRows()).toEqual([EXIT_TEXT])
  })

  it('leaves the row to the loop when the exit lands while the message still waits', async () => {
    exitOnStart = true
    const queued = await send('hello')

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({ dispatchState: 'rejected' })
    )
    await host.flushStreamedEvents(SESSION)

    expect(dispatch).not.toHaveBeenCalled()
    expect(await startRows()).toEqual([EXIT_TEXT])
    // Written once, after the message was settled, not first by the exit and again by the loop.
    expect(publishedStartRows()).toEqual([EXIT_TEXT])
  })
})
