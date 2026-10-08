// A start that fails fails only the message it was for, and the messages behind it each get their
// own start. Three writers settle a failed start, one per state the message is in: the delivery
// loop the queued message the start was for, the handover the message being handed over, and the
// exit any message handed to a child that never proved its start. Every write names a message fixed
// when its pass chose it, so a failure on the way never lands on another message. The chat gets one
// row for that start, in the words the message was rejected with.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import {
  isStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowIdentity
} from '../../../shared/structured-agent-session-start-failure-row-key'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleBatchInput } from '../agent-session-journal/journal-store-contracts'
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
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const SETUP_FAILURE = agentSessionFailureFact('managedAccountUnsupported')
const SETUP_ROW = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1'))
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'
// The exit's reason is Orca's log text; the row says only that the start stopped.
const EXIT_TEXT = 'Codex stopped before it finished starting. Send your message to try again.'
// A child that ran and could not finish its start.
const PROVIDER_START_FAILED = agentSessionFailureFact('providerStartFailed')
// A start refused before its child ran: the CLI is not there.
const MISSING_CLI = () => new AgentSessionPreSpawnError(new Error('spawn codex ENOENT'))
const HOST_FAULT_WORDS = agentSessionFailureWords(agentSessionFailureFact('hostFault'), {
  surface: 'rejection'
})

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let generation = 0
// Runs before each spawn; throwing refuses that start before it ran.
let beforeSpawn = vi.fn<() => Promise<void>>()
/** The next start's child exits as its start step returns, before the handover step. */
let exitOnStart = false
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let closeSession = vi.fn<NonNullable<StructuredAgentSessionAdapter['closeSession']>>()
let frames: AgentSessionSubscribeEvent[] = []

function exitBeforeProof(failure?: SubmissionRejectionFact): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true,
    ...(failure ? { failure } : {})
  })
}

function startHost(): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: log.logger,
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        await beforeSpawn()
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
          exitOnStart = false
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
      closeSession,
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
  return sent.ok ? sent.value.clientMessageId : ''
}

/** Sent, and handed to its starting child, which has not answered. */
async function sendHanded(text: string): Promise<string> {
  const id = await send(text)
  await eventually(() => expect(dispatched()).toContain(id))
  return id
}

async function rejected(clientMessageId: string): Promise<void> {
  await eventually(async () =>
    expect(await submission(clientMessageId)).toMatchObject({ dispatchState: 'rejected' })
  )
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

/** The start-failure rows written since setup, whose own failed start (generation-1) left one. */
async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    isStructuredAgentSessionStartFailureRow(item.itemId) && item.itemId !== SETUP_ROW
      ? [item.itemId]
      : []
  )
}

/** The row a failed start leaves for the message it was for. */
function rowFor(clientMessageId: string): string {
  return agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(clientMessageId))
}

/** Every dispatch state a subscriber was told for one message, in order. */
function framedStates(clientMessageId: string): string[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.submissions
          .filter((entry) => entry.clientMessageId === clientMessageId)
          .map((entry) => entry.dispatchState)
      : []
  )
}

function dispatched(): string[] {
  return dispatch.mock.calls.map(([input]) => input.clientMessageId)
}

/** Records each failed start's write the journal is asked for, in order; with `fail`, fails the
 *  first `times` (one by default), before they land or after. */
function spyRejections(fail?: { when: 'before' | 'after'; times?: number }): string[] {
  const order: string[] = []
  const append = AgentSessionJournal.prototype.appendLifecycleBatch
  let failures = 0
  vi.spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch').mockImplementation(
    async function (this: AgentSessionJournal, input: JournalLifecycleBatchInput) {
      const rejected = input.rejects?.clientMessageId
      if (rejected !== undefined) {
        order.push(`rejected ${rejected}`)
      }
      if (!fail || failures >= (fail.times ?? 1) || rejected === undefined) {
        return append.call(this, input)
      }
      failures += 1
      if (fail.when === 'after') {
        await append.call(this, input)
      }
      throw new Error('journal write failed')
    }
  )
  return order
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  frames = []
  log = recordingStructuredAgentSessionLogger()
  beforeSpawn = vi.fn(async () => undefined)
  exitOnStart = false
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  closeSession = vi.fn(async () => true)
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
  // The first child (generation-1) is lost at setup; the first send starts generation-2. Its row
  // states another failure, so it never speaks for a test's own failed start.
  await exitBeforeProof(SETUP_FAILURE)
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

// The provider took the message and opened its turn, so the next one may be handed over.
const accepted: StructuredAgentSessionAdapter['dispatch'] = async () => ({
  state: 'accepted',
  providerIdentity: {
    provider: 'codex',
    threadId: THREAD,
    turnId: `turn-${dispatch.mock.calls.length}`,
    ordinal: dispatch.mock.calls.length
  }
})

describe('a queued message whose start fails', () => {
  it('fails only itself: each message behind it gets its own start', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })
    dispatch.mockImplementation(accepted)
    const first = await send('first')
    const second = await send('second')
    const third = await send('third')

    await eventually(() => expect(dispatched()).toEqual([second, third]))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'restartFailed' }
    })
    for (const id of [second, third]) {
      expect(framedStates(id)).not.toContain('rejected')
    }
    // One row per failed start: the first's, and none for the messages that went on.
    expect(await startRows()).toEqual([rowFor(first)])
  })

  it('ends a failed child still there when the next message comes, and starts afresh', async () => {
    // Its dispatch faults while the child is still starting: a failed start, with no exit seen.
    dispatch.mockRejectedValueOnce(new Error('codex app-server pipe closed'))
    const failed = await send('first')
    await rejected(failed)
    expect(await startRows()).toEqual([rowFor(failed)])
    // Not ended at once: an exit of its own may already be on its way.
    expect(closeSession).not.toHaveBeenCalled()

    const next = await send('second')

    await eventually(() => expect(dispatched()).toEqual([failed, next]))
    expect(closeSession).toHaveBeenCalledOnce()
    expect(generation).toBe(3)
  })
  // A child past its start that dies says so in its exit's own row.
  it('writes no start row for a send a started child refused because it ended', async () => {
    dispatch.mockImplementation(accepted)
    const first = await send('first')
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({ dispatchState: 'accepted' })
    )
    await host.handleAdapterEvent({
      type: 'started',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      acquisitionGeneration: `generation-${generation}`,
      reportedOptions: { model: 'gpt-5' },
      restoreSkippedOptions: []
    })
    dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        surface: 'rejection'
      })
    })

    const second = await send('second')

    await rejected(second)
    expect(await startRows()).toEqual([])
  })
})

describe('a failure on the way to recording a failed start', () => {
  it('retries the same message when the rejection did not land, and never fails the one behind it', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })
    spyRejections({ when: 'before' })
    const first = await send('first')
    const second = await send('second')

    // The catch's retry is Orca's fault, worded as one; the message behind it goes on.
    await eventually(async () =>
      expect(await submission(first)).toMatchObject({
        dispatchState: 'rejected',
        ...HOST_FAULT_WORDS
      })
    )
    await eventually(() => expect(dispatched()).toEqual([second]))
    expect(framedStates(second)).not.toContain('rejected')
  })

  it('never fails the message behind one whose rejection landed before the error', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })
    spyRejections({ when: 'after' })
    const first = await send('first')
    const second = await send('second')

    await eventually(() => expect(dispatched()).toEqual([second]))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'restartFailed' }
    })
    expect(framedStates(second)).not.toContain('rejected')
    expect(log.entries.map((entry) => entry.fields.scope)).toContain('delivery-loop')
  })

  it('records the failure before ending the failed child, so a failed cleanup loses nothing', async () => {
    const order = spyRejections()
    dispatch.mockRejectedValueOnce(new Error('codex app-server pipe closed'))
    closeSession.mockImplementation(async () => {
      order.push('cleanup')
      throw new Error('stop failed')
    })
    const first = await send('first')
    await rejected(first)
    const second = await send('second')

    await rejected(second)
    expect(order.slice(0, 2)).toEqual([`rejected ${first}`, 'cleanup'])
    expect(log.entries.map((entry) => entry.fields.scope)).toContain(
      'delivery-loop-end-failed-start'
    )
    // The stop could not prove the exit, so the next start is refused for that, in its own words.
    expect(await submission(second)).toMatchObject({
      rejection: {
        kind: 'restartFailed',
        refusal: { details: { reason: 'previousExitUnverifiable' } }
      }
    })
    expect(dispatched()).toEqual([first])
    // Quit's own stop of the old child succeeds.
    closeSession.mockImplementation(async () => true)
  })
})

describe('a start that fails while its child exits', () => {
  it('leaves the row to the loop when the exit lands while the message still waits', async () => {
    exitOnStart = true
    const queued = await send('hello')

    await rejected(queued)
    await host.flushStreamedEvents(SESSION)

    expect(dispatch).not.toHaveBeenCalled()
    expect(await submission(queued)).toMatchObject({ reason: EXIT_TEXT })
    // Written once, with the message, not first by the exit and again by the loop.
    expect(await startRows()).toEqual([rowFor(queued)])
  })

  // Neither the loop nor its catch could record the failure, so the message stayed queued.
  it('records the start on the message it was for when its child ends, rather than starting again', async () => {
    exitOnStart = true
    spyRejections({ when: 'before', times: 2 })
    const queued = await send('hello')
    await eventually(() =>
      expect(log.entries.map((entry) => entry.fields.scope)).toContain('delivery-loop-fail')
    )
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    const startsBefore = generation

    // The next wake reads the ended start off its child, not a fresh start for it.
    const next = await send('next')

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    await eventually(() => expect(dispatched()).toEqual([next]))
    expect(generation).toBe(startsBefore + 1)
    expect(await startRows()).toEqual([rowFor(queued)])
  })

  it("writes one row in the exit's words for a message the child was handed, never in doubt", async () => {
    const handed = await sendHanded('hello')
    expect(await submission(handed)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(handed)).toMatchObject({
        dispatchState: 'rejected',
        reason: EXIT_TEXT,
        rejection: PROVIDER_START_FAILED
      })
    )
    // Never in doubt on the way: the child it was handed to took nothing.
    expect(framedStates(handed)).not.toContain('unknown')
    // The exit rejected it, so the exit writes the start's one row, keyed by it.
    expect(await startRows()).toEqual([rowFor(handed)])
  })

  // The message behind it was never handed to that child: it gets a start of its own.
  it('fails a handed message with its start, and the message waiting behind it starts afresh', async () => {
    const handed = await sendHanded('handed')
    // Held while the turn ahead opens, which it never does; its pass has found nothing to hand over.
    const queued = await send('queued')
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
    dispatch.mockImplementation(accepted)

    await exitBeforeProof()

    await rejected(handed)
    await eventually(() => expect(dispatched()).toEqual([handed, queued]))
    expect(framedStates(queued)).not.toContain('rejected')
    expect(await startRows()).toEqual([rowFor(handed)])
  })

  // Its pass joined the starting child and waits to hand it over when the exit lands between steps.
  it('gives a message that only joined the failed start its own start', async () => {
    const handed = await sendHanded('handed')
    dispatch.mockImplementation(accepted)
    const joined = await send('joined')

    await exitBeforeProof()

    await rejected(handed)
    await eventually(() => expect(dispatched()).toEqual([handed, joined]))
    expect(framedStates(joined)).not.toContain('rejected')
    expect(await startRows()).toEqual([rowFor(handed)])
  })
})

// One row speaks for a run of starts that fail alike, until a turn is delivered. Each message still
// makes its own start and is rejected on its own; the run's row says why for all of them.
describe('a run of starts that fail alike', () => {
  it('writes one row when every start fails alike, each message making its own attempt', async () => {
    const completions: AgentSessionTurnCompletionEvent[] = []
    host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })
    beforeSpawn.mockImplementation(async () => {
      throw MISSING_CLI()
    })
    const startsBefore = beforeSpawn.mock.calls.length
    const first = await send('first')
    const second = await send('second')
    const third = await send('third')

    await rejected(third)
    for (const id of [first, second, third]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'restartFailed' }
      })
    }
    expect(beforeSpawn.mock.calls.length - startsBefore).toBe(3)
    expect(await startRows()).toEqual([rowFor(first)])
    await host.flushStreamedEvents(SESSION)
    expect(completions).toHaveLength(1)
    // A client that hides rejected messages reads the run's one row, as before.
    const snapshot = await host.journalSnapshot(SESSION)
    const row = snapshot.items.find((item) => item.itemId === rowFor(first))?.body
    const drawn = projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions, {
      rejectedInPlace: false
    })
    const texts = drawn.flatMap((message) =>
      message.blocks.flatMap((block) => ('text' in block ? [block.text] : []))
    )
    expect(row?.kind === 'status' ? texts.filter((text) => text === row.text) : []).toHaveLength(1)
    for (const id of [first, second, third]) {
      expect(drawn.map((message) => message.id)).not.toContain(agentJournalSubmissionKey(id))
    }
  })

  it('writes one row when a start fails once and the messages behind it are delivered', async () => {
    const first = await sendHanded('first')
    const second = await send('second')
    const third = await send('third')
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
    dispatch.mockImplementation(accepted)

    await exitBeforeProof()

    await eventually(() => expect(dispatched()).toEqual([first, second, third]))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      rejection: PROVIDER_START_FAILED
    })
    for (const id of [second, third]) {
      expect(await submission(id)).toMatchObject({ dispatchState: 'accepted' })
    }
    expect(await startRows()).toEqual([rowFor(first)])
  })

  it('writes a row for each failure when the starts fail differently', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })
    const first = await send('first')
    await rejected(first)
    const second = await sendHanded('second')

    await exitBeforeProof()

    await rejected(second)
    expect(await startRows()).toEqual([rowFor(first), rowFor(second)])
  })

  it('writes a row again for a failure alike once a turn was delivered after the last row', async () => {
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })
    dispatch.mockImplementation(accepted)
    const first = await send('first')
    await rejected(first)
    const delivered = await send('delivered')
    await eventually(async () =>
      expect(await submission(delivered)).toMatchObject({ dispatchState: 'accepted' })
    )
    // The delivered turn's child proved its start and later ends, so the next message makes its own.
    const child = {
      sessionId: SESSION,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      acquisitionGeneration: `generation-${generation}`
    }
    await host.handleAdapterEvent({
      type: 'started',
      ...child,
      reportedOptions: { model: 'gpt-5' },
      restoreSkippedOptions: []
    })
    await host.handleAdapterEvent({
      type: 'ended',
      ...child,
      reason: 'codex app-server exited',
      cause: 'unexpected-exit'
    })
    beforeSpawn.mockImplementationOnce(async () => {
      throw MISSING_CLI()
    })

    const last = await send('last')

    await rejected(last)
    expect(await startRows()).toEqual([rowFor(first), rowFor(last)])
  })

  // Codex's stderr is a log: its tracing stamps each line, so two exits alike differ in the time.
  it('writes one row for two startup exits whose stderr differs only by its timestamp', async () => {
    const stderr = (at: string) =>
      agentSessionFailureFact('providerExited', {
        detail: {
          text: `${at} ERROR codex_app_server: unknown field \`foo\` in config.toml`,
          audience: 'log'
        }
      })
    const first = await sendHanded('first')
    await exitBeforeProof(stderr('2026-10-07T01:02:03.456789Z'))
    await rejected(first)
    const second = await sendHanded('second')

    await exitBeforeProof(stderr('2026-10-07T01:02:09.012345Z'))

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'providerStartFailed', detail: { audience: 'log' } }
      })
    )
    expect(await startRows()).toEqual([rowFor(first)])
  })

  // Words written for a person name what failed: two that differ are two failures.
  it('writes a row for each of two exits whose words for a person differ', async () => {
    const refused = (text: string) =>
      agentSessionFailureFact('providerStartFailed', { detail: { text, audience: 'person' } })
    const first = await sendHanded('first')
    await exitBeforeProof(refused('no rollout found for thread id t-1'))
    await rejected(first)
    const second = await sendHanded('second')

    await exitBeforeProof(refused('no rollout found for thread id t-2'))

    await rejected(second)
    expect(await startRows()).toEqual([rowFor(first), rowFor(second)])
  })

  it("writes no row for an exit that fails alike its run's row, though it rejected the message", async () => {
    const first = await sendHanded('first')
    await exitBeforeProof()
    await rejected(first)
    const second = await sendHanded('second')

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    expect(await startRows()).toEqual([rowFor(first)])
  })
})
