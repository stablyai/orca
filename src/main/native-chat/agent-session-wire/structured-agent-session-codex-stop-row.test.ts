// What a Stop's row says when Codex took the interrupt, against the real host, journal and Codex
// adapter. Codex answers a turn's interrupt as the turn aborts and sends the turn's end right after
// the answer, so the end reaches Orca a moment after the Stop has its answer.

import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-connection'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>
let codex: ReturnType<typeof fakeCodex>
let notify: (method: string, params: unknown) => void
/** Read at each start, so a test can say what the next start resumes. */
let launch: { resumeThreadId?: string | null }
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let disposeSession: MockInstance<NonNullable<StructuredAgentSessionAdapter['disposeSession']>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stop-row-'))
  resetHostTestOperationIds()
  codex = fakeCodex()
  notify = (method, params) => codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  codex.routes['turn/start'] = turns.routes['turn/start']
  codex.routes['turn/interrupt'] = () => {
    const turnId = turns.turnId
    // The answer first, then the turn's end on a later read of Codex's output.
    setTimeout(
      () =>
        notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'interrupted' } }),
      4
    )
    return {}
  }
  const store = await openTestAgentSessionRecordStore(root)
  // The runtime's wiring: an echo accepts its send, and every exit reaches the host.
  launch = {}
  const adapter = adapterFor(codex, launch, [], {
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  disposeSession = vi.spyOn(adapter, 'disposeSession')
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: (log = recordingStructuredAgentSessionLogger()).logger,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
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
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
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

async function runningTurn(): Promise<void> {
  const sent = await send('count to 40')
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  turns.start()
  turns.echo(sent.value.clientMessageId)
  await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['running']))
}

async function journalRows() {
  const items = (await host.journalSnapshot(SESSION)).items
  return {
    statuses: items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : [])),
    turns: items.flatMap((item) => (item.body.kind === 'turn' ? [item.body.state] : [])),
    outcomes: items.flatMap((item) => (item.body.kind === 'turn' ? [item.body.outcome] : []))
  }
}

/** Codex's -32600 states the named turn is not running; its -32603 is an interrupt it could not
 *  submit, the turn still running. */
function refused(message: string, code: -32600 | -32603 = -32600): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    'turn/interrupt',
    code,
    `codex app-server turn/interrupt failed: ${message}`,
    message
  )
}

function interruptFailure(failure: 'internal error' | 'unanswered'): Error {
  return failure === 'internal error'
    ? refused('failed to interrupt turn: channel closed', -32603)
    : new CodexAppServerTimeoutError('codex app-server turn/interrupt exceeded 30000ms')
}

/** Codex picked the follow-up's turn and answered the send, and has not started it. */
async function followUpUnopened(): Promise<void> {
  const sent = await send('and then this')
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-2'))
  await host.flushStreamedEvents(SESSION)
}

/** Whether the Stop ended the child: the host's stop, which proves the exit. Nothing else here
 *  stops it before the test's teardown. */
function childEndedByStop(): boolean {
  return disposeSession.mock.calls.length > 0
}

describe('a Codex Stop that Codex answered', () => {
  it.each([
    ['names no turn', undefined],
    ['names its turn, as an older client sends it', 'turn-1']
  ] as const)(
    'reads as requested, with the turn interrupted, when it %s',
    async (_case, turnId) => {
      await runningTurn()

      const stopped = await stop(turnId)
      await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['interrupted']))
      await host.flushStreamedEvents(SESSION)

      expect((await journalRows()).statuses).toEqual(['Cancellation requested.'])
      expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
      // Codex's background terminals live in its child, so a Stop it took keeps the child.
      expect(childEndedByStop()).toBe(false)
      expect(codex.connections.at(-1)?.closed).toBe(false)
    }
  )
})

describe('a Codex Stop whose interrupt failed', () => {
  it.each([
    ['Codex could not submit it, naming no turn', undefined, 'internal error'],
    ['Codex could not submit it, naming its turn', 'turn-1', 'internal error'],
    ['unanswered, naming no turn', undefined, 'unanswered'],
    ['unanswered, naming its turn', 'turn-1', 'unanswered']
  ] as const)(
    "ends the child still running the turn, as the user's cancellation, when %s",
    async (_case, turnId, failure) => {
      await runningTurn()
      codex.routes['turn/interrupt'] = () => {
        throw interruptFailure(failure)
      }

      const stopped = await stop(turnId)
      await host.flushStreamedEvents(SESSION)

      expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(disposeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
      expect(codex.connections.at(-1)?.closed).toBe(true)
      const rows = await journalRows()
      expect(rows.turns).toEqual(['interrupted'])
      expect(rows.outcomes).toEqual(['cancellation'])
      expect(rows.statuses).toEqual(['Cancellation requested.'])
    }
  )

  it('says Codex did not stop when a Stop naming the running turn could not prove the exit', async () => {
    await runningTurn()
    codex.routes['turn/interrupt'] = () => {
      throw interruptFailure('internal error')
    }
    disposeSession.mockResolvedValueOnce(false)

    const stopped = await stop('turn-1')
    await host.flushStreamedEvents(SESSION)

    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(disposeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect((await journalRows()).statuses).toEqual([
      "Codex didn't stop. Check the chat before trying again."
    ])
  })

  it.each([
    ['naming no turn', undefined],
    ['naming its turn', 'turn-1']
  ] as const)(
    'keeps the child when Codex has moved on to another turn, %s',
    async (_case, turnId) => {
      await runningTurn()
      // Codex ended the turn and opened another before the interrupt reached it.
      codex.routes['turn/interrupt'] = () => {
        turns.end('completed')
        notify('turn/started', { threadId: THREAD, turn: { id: 'turn-2', status: 'inProgress' } })
        throw refused('expected active turn id turn-1 but found turn-2')
      }

      const stopped = await stop(turnId)
      await host.flushStreamedEvents(SESSION)

      expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
      expect(childEndedByStop()).toBe(false)
      expect(codex.connections.at(-1)?.closed).toBe(false)
      expect((await journalRows()).turns).toEqual(['completed', 'running'])
    }
  )

  // Codex marks the turn ended before it writes the frame, so its refusal can come first.
  it.each([
    ['naming no turn', undefined],
    ['naming its turn', 'turn-1']
  ] as const)(
    "keeps the child when Codex's refusal arrives before the turn's end, %s",
    async (_case, turnId) => {
      await runningTurn()
      codex.routes['turn/interrupt'] = () => {
        setTimeout(() => turns.end('completed'), 2)
        throw refused('no active turn to interrupt')
      }

      const stopped = await stop(turnId)
      await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['completed']))
      await host.flushStreamedEvents(SESSION)

      expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
      expect(childEndedByStop()).toBe(false)
      expect(codex.connections.at(-1)?.closed).toBe(false)
      expect((await journalRows()).outcomes).toEqual(['success'])
    }
  )

  it.each([
    ['naming no turn', undefined],
    ['naming its turn', 'turn-1']
  ] as const)(
    'keeps the child when the turn ended before the interrupt reached it, %s',
    async (_case, turnId) => {
      await runningTurn()
      codex.routes['turn/interrupt'] = (params) => {
        turns.end('completed')
        return turns.routes['turn/interrupt'](params)
      }

      const stopped = await stop(turnId)
      await host.flushStreamedEvents(SESSION)

      expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
      expect(childEndedByStop()).toBe(false)
      expect(codex.connections.at(-1)?.closed).toBe(false)
      expect((await journalRows()).turns).toEqual(['completed'])
    }
  )

  it('keeps the child at rest, and writes no row, when a Stop names a turn that already ended', async () => {
    await runningTurn()
    turns.end('completed')
    await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['completed']))
    codex.routes['turn/interrupt'] = turns.routes['turn/interrupt']

    const stopped = await stop('turn-1')
    await host.flushStreamedEvents(SESSION)

    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(childEndedByStop()).toBe(false)
    expect(codex.connections.at(-1)?.closed).toBe(false)
    expect((await journalRows()).statuses).toEqual([])
  })

  // A phone names the turn it shows; a follow-up from elsewhere is not that Stop's to end.
  it.each([
    ['Codex refused it', 'refused'],
    ['the interrupt went unanswered', 'unanswered']
  ] as const)(
    'keeps the child when a Stop names a turn that ended and a follow-up has not opened, %s',
    async (_case, failure) => {
      await runningTurn()
      turns.end('completed')
      await vi.waitFor(async () => expect((await journalRows()).turns).toEqual(['completed']))
      await followUpUnopened()
      codex.routes['turn/interrupt'] =
        failure === 'refused'
          ? turns.routes['turn/interrupt']
          : () => {
              throw interruptFailure('unanswered')
            }

      const stopped = await stop('turn-1')
      await host.flushStreamedEvents(SESSION)

      expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
      expect(childEndedByStop()).toBe(false)
      expect(codex.connections.at(-1)?.closed).toBe(false)
    }
  )

  it("decides on Codex's frames received before the interrupt failed, not on the journal's last write", async () => {
    await runningTurn()
    // Each frame lands in the journal as Codex hands it over, before the interrupt fails.
    codex.routes['turn/interrupt'] = () => {
      turns.end('completed')
      notify('turn/started', { threadId: THREAD, turn: { id: 'turn-2', status: 'inProgress' } })
      throw interruptFailure('internal error')
    }

    const stopped = await stop('turn-1')
    await host.flushStreamedEvents(SESSION)

    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(childEndedByStop()).toBe(false)
    expect((await journalRows()).turns).toEqual(['completed', 'running'])
  })

  it('holds a card queued before it while the child it ends goes, its event written first', async () => {
    await runningTurn()
    const body = hostTestMessage('queued before the Stop')
    const delivery = 'queue-if-active' as const
    const queued = await host.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body, delivery }
        })
      },
      body,
      delivery
    })
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
    }
    const cardId = queued.value.queued.messageId
    codex.routes['turn/interrupt'] = () => {
      throw interruptFailure('internal error')
    }

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await host.flushStreamedEvents(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(childEndedByStop()).toBe(true)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuePause).toEqual({ reason: 'stopped' })
    expect(
      (await host.journalSnapshot(SESSION)).submissions.filter(
        (entry) => entry.queuedMessageId === cardId
      )
    ).toEqual([])
    const journal = host['sessions'].get(SESSION)!.journal
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    const rows = since.ok ? since.rows : []
    const stopAt = rows.find((row) => row.kind === 'tombstone' && row.stopEvent)?.seq
    // The turn's end, from the child's end or Codex's own frame, in whatever row carries it.
    const endAt = rows.find((row) => JSON.stringify(row).includes('"state":"interrupted"'))?.seq
    expect(stopAt).toBeLessThan(endAt ?? 0)
  })

  it('leaves a child that exited during the interrupt to its exit', async () => {
    await runningTurn()
    codex.routes['turn/interrupt'] = () => {
      const exited = new Error('codex app-server exited')
      codex.connections.at(-1)?.handlers.onExit?.(exited)
      throw exited
    }

    const stopped = await stop()
    await host.flushStreamedEvents(SESSION)

    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(childEndedByStop()).toBe(false)
  })
})

describe('a message after a Codex Stop whose exit was unproven', () => {
  /** A Stop whose interrupt fails ends the child, whose close cannot prove the exit `failures`
   *  times. As the real connection, it refuses every request once a close begins. */
  async function stopWithUnprovenClose(failures: number) {
    await runningTurn()
    codex.routes['turn/interrupt'] = () => {
      throw interruptFailure('internal error')
    }
    const old = codex.connections.at(-1)!
    const close = old.close
    const request = old.request
    let unproven = failures
    old.close = async () => {
      old.closed = true
      if (unproven === 0) {
        return close()
      }
      unproven -= 1
      return false
    }
    old.request = (method, params) =>
      old.closed
        ? Promise.reject(new Error('codex app-server is closing'))
        : request(method, params)
    await stop()
    await host.flushStreamedEvents(SESSION)
    return old
  }

  const startedWith = (connection: (typeof codex.connections)[number], text: string) =>
    connection.calls.some(
      (call) => call.method === 'turn/start' && JSON.stringify(call.params).includes(text)
    )

  it('rejects the message while the close stays unverifiable, and starts no Codex beside it', async () => {
    const old = await stopWithUnprovenClose(2)

    const sent = await send('carry on')
    if (!sent.ok || !('submission' in sent.value)) {
      throw new Error(JSON.stringify(sent))
    }
    const id = sent.value.submission.clientMessageId
    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === id
        )
      ).toMatchObject({
        dispatchState: 'rejected',
        reason: "Couldn't stop Codex from before. Send your message again to try once more."
      })
    )
    expect(codex.connections).toHaveLength(1)
    expect(startedWith(old, 'carry on')).toBe(false)
    expect(host['sessions'].get(SESSION)?.child?.close).toBeDefined()
  })

  it('ends the record when the root exits after its close gave up, with no one asking again', async () => {
    const old = await stopWithUnprovenClose(1)
    const handled = vi.spyOn(host, 'handleAdapterEvent')

    old.handlers.onExit?.(new Error('codex app-server exited'), { expected: true })

    // The close Orca began, ended: Orca's, never blamed on Codex as a crash.
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'requested-close', failure: { kind: 'hostFault' } })
    )
    await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child).toBeNull())
    expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({ cause: 'user-stop' })
    expect(codex.connections).toHaveLength(1)
  })

  it('joins that close first, then goes to a fresh Codex, never to the old one', async () => {
    const old = await stopWithUnprovenClose(1)
    expect(host['sessions'].get(SESSION)?.child?.close).toMatchObject({ cause: 'user-stop' })
    // The next start resumes the chat's thread, as the runtime's launch resolves it from the record.
    launch.resumeThreadId = THREAD

    const sent = await send('carry on')
    expect(sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(codex.connections).toHaveLength(2))
    await vi.waitFor(() => expect(startedWith(codex.connections[1]!, 'carry on')).toBe(true))
    expect(startedWith(old, 'carry on')).toBe(false)
    expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({ cause: 'user-stop' })
  })

  it('reports a process tree left unproven by a proven root exit, and ends the record anyway', async () => {
    await runningTurn()
    codex.routes['turn/interrupt'] = () => {
      throw interruptFailure('internal error')
    }
    const old = codex.connections.at(-1)!
    // The forced kill saw the root exit but could not prove the rest of the tree gone.
    Object.defineProperty(old, 'processTreeUnproven', { get: () => old.closed })

    await stop()

    await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child).toBeNull())
    expect(log.entries.map((entry) => entry.fields.scope)).toContain('provider-close-after-exit')
    expect(host['sessions'].get(SESSION)?.lastEndedChild).toMatchObject({ rootGone: true })
  })
})
