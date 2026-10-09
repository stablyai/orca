// A Stop is saved before it acts: its acceptance (its receipt, its Stop event and every send it
// holds) commits first, and only then does it interrupt or end the child. One that cannot be saved
// acts on nothing, so the agent keeps running, and the person is asked to try again.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let log: ReturnType<typeof hostTestState>['log']

beforeEach(() => {
  ;({ host, acquire, cancelTurn, log } = hostTestState())
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function runningTurn(): Promise<AgentSessionJournal> {
  await attach()
  acquire.mock.calls
    .at(-1)![0]
    .events!.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 900 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('no open journal')
  }
  // The turn row landed when the provider's event was handed over.
  expect(journal.activeTurnId()).toBe('turn-1')
  return journal
}

/** A child the adapter published before proving its startup, so a Stop ends the start. */
async function startingChild(): Promise<{ journal: AgentSessionJournal; closeSession: Mock }> {
  const acquired = acquire.getMockImplementation()!
  acquire.mockImplementationOnce(async (input) => ({
    ...(await acquired(input)),
    providerChildPhase: 'starting' as const
  }))
  const closeSession = vi.fn(async () => true)
  Object.assign(host.deps.adapter, { closeSession })
  await attach()
  const session = host.collaboratorsForTests().sessions.get(SESSION)
  if (!session) {
    throw new Error('no open session')
  }
  expect(session.child?.phase).toBe('starting')
  return { journal: session.journal, closeSession }
}

function stop(fields: { turnId?: string }) {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

const UNWRITABLE = 'disk I/O error'

/** The refusal a Stop whose acceptance could not be saved answers: plain words, a next step. */
const NOT_SAVED = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'journalWriteFailed' },
    message: expect.stringMatching(/^Couldn't stop .+\. Try again\.$/)
  }
}

/** Holds the Stop's acceptance until released, then lets it land. */
function holdAcceptance(journal: AgentSessionJournal, order: string[]): () => void {
  const accept = journal.stops.accept.bind(journal.stops)
  const held = Promise.withResolvers<void>()
  vi.spyOn(journal.stops, 'accept').mockImplementation(async (...args) => {
    await held.promise
    const accepted = await accept(...args)
    order.push('saved')
    return accepted
  })
  return () => held.resolve()
}

describe.each([
  ['naming no turn', {}],
  ['naming its turn', { turnId: 'turn-1' }]
])('a Stop %s', (_label, fields) => {
  it('interrupts nothing when its acceptance cannot be saved: the agent keeps running', async () => {
    const journal = await runningTurn()
    vi.spyOn(journal.stops, 'accept').mockRejectedValue(new Error(UNWRITABLE))

    expect(await stop(fields)).toMatchObject(NOT_SAVED)
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.activeTurnId()).toBe('turn-1')
    expect(journal.stopMarks.latest()).toBeNull()
  })

  it('interrupts only once its acceptance is saved', async () => {
    const journal = await runningTurn()
    const order: string[] = []
    const release = holdAcceptance(journal, order)
    cancelTurn.mockImplementation(async () => {
      order.push('interrupt')
      return { cancelled: true }
    })

    const stopping = stop(fields)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(cancelTurn).not.toHaveBeenCalled()
    release()

    expect(await stopping).toMatchObject({ ok: true })
    expect(order).toEqual(['saved', 'interrupt'])
  })

  // A provider whose Stop ends its session: neither the interrupt nor the child's end goes out.
  it("neither interrupts nor ends a session-ending provider's child when it cannot be saved", async () => {
    const journal = await runningTurn()
    const closeSession = vi.fn(async () => true)
    Object.assign(host.deps.adapter, { stopEndsSession: () => true, closeSession })
    vi.spyOn(journal.stops, 'accept').mockRejectedValue(new Error(UNWRITABLE))

    expect(await stop(fields)).toMatchObject(NOT_SAVED)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(closeSession).not.toHaveBeenCalled()
  })
})

describe('a Stop naming no turn, at an agent still starting', () => {
  it('leaves a starting child alone when its acceptance cannot be saved', async () => {
    const { journal, closeSession } = await startingChild()
    vi.spyOn(journal.stops, 'accept').mockRejectedValue(new Error(UNWRITABLE))

    expect(await stop({})).toMatchObject(NOT_SAVED)
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('ends a starting child only once its acceptance is saved', async () => {
    const { journal, closeSession } = await startingChild()
    const order: string[] = []
    const release = holdAcceptance(journal, order)
    closeSession.mockImplementation(async () => {
      order.push('stop')
      return true
    })

    const stopping = stop({})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closeSession).not.toHaveBeenCalled()
    release()

    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(order).toEqual(['saved', 'stop'])
  })
})

// A turn named once its start is gone is about a child already gone: a newer start is not its own.
it('leaves a newer start alone when the Stop names a turn already over, recording only a no-op', async () => {
  const { journal, closeSession } = await startingChild()
  const acceptStop = vi.spyOn(journal.stops, 'accept')

  expect(await stop({ turnId: 'turn-1' })).toMatchObject({
    ok: true,
    value: { turnId: 'turn-1', cancelled: false }
  })
  expect(acceptStop).not.toHaveBeenCalled()
  expect(closeSession).not.toHaveBeenCalled()
})

it('reports a Stop it could not save', async () => {
  const journal = await runningTurn()
  vi.spyOn(journal.stops, 'accept').mockRejectedValue(new Error(UNWRITABLE))
  await stop({})
  expect(log.entries).toContainEqual(
    expect.objectContaining({
      level: 'warn',
      message: 'saving a Stop failed; the agent was not interrupted',
      fields: expect.objectContaining({ error: expect.objectContaining({ message: UNWRITABLE }) })
    })
  )
})
