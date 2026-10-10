// A Stop's interrupt never waits on the journal. Its withdrawal and its Stop event are bookkeeping:
// one that throws is reported and the Stop still interrupts.

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

const MALFORMED = 'database disk image is malformed'

/** The Stop reported `step`'s failure through the host's logger. */
function expectReported(step: 'withdrawal' | 'event row'): void {
  expect(log.entries).toContainEqual(
    expect.objectContaining({
      level: 'warn',
      message: `Stop's ${step} failed`,
      fields: expect.objectContaining({ error: expect.objectContaining({ message: MALFORMED }) })
    })
  )
}
/** The held write fails only once the interrupt went out; a Stop that awaited it times out here. */
const INTERRUPT_WAIT = { timeout: 5_000 }

describe.each([
  ['naming no turn', {}],
  ['naming its turn', { turnId: 'turn-1' }]
])('a Stop %s', (_label, fields) => {
  it('interrupts when withdrawing the queued sends throws, and reports it', async () => {
    const journal = await runningTurn()
    vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(() => {
      throw new Error(MALFORMED)
    })

    expect(await stop(fields)).toMatchObject({ ok: true })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expectReported('withdrawal')
  })

  it('interrupts when writing its Stop event throws, and reports it', async () => {
    const journal = await runningTurn()
    vi.spyOn(journal, 'appendStopEvent').mockImplementation(() => {
      throw new Error(MALFORMED)
    })

    expect(await stop(fields)).toMatchObject({ ok: true })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expectReported('event row')
  })

  // Held, then failing: the interrupt goes out while the write is still pending, not after it settles.
  it.each([
    ['withdrawing the queued sends', 'withdrawal'],
    ['writing its Stop event', 'event row']
  ] as const)('interrupts before %s settles, then reports its failure', async (step, failed) => {
    const journal = await runningTurn()
    const order: string[] = []
    const held = Promise.withResolvers<never>()
    if (step === 'withdrawing the queued sends') {
      vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(() => held.promise)
    } else {
      vi.spyOn(journal, 'appendStopEvent').mockImplementation(() => held.promise)
    }
    cancelTurn.mockImplementation(async () => {
      order.push('interrupt')
      return { cancelled: true }
    })

    const stopping = stop(fields)
    try {
      await vi.waitFor(() => expect(cancelTurn).toHaveBeenCalledOnce(), INTERRUPT_WAIT)
    } finally {
      order.push('write fails')
      held.reject(new Error(MALFORMED))
    }

    expect(await stopping).toMatchObject({ ok: true })
    expect(order).toEqual(['interrupt', 'write fails'])
    expectReported(failed)
  })

  it.each([
    ['withdrawing the queued sends', 'withdrawal'],
    ['writing its Stop event', 'event row']
  ] as const)(
    'ends a starting child before %s settles, then reports its failure',
    async (step, failed) => {
      const { journal, closeSession } = await startingChild()
      const order: string[] = []
      const held = Promise.withResolvers<never>()
      if (step === 'withdrawing the queued sends') {
        vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(() => held.promise)
      } else {
        vi.spyOn(journal, 'appendStopEvent').mockImplementation(() => held.promise)
      }
      closeSession.mockImplementation(async () => {
        order.push('stop')
        return true
      })

      const stopping = stop(fields)
      try {
        await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce(), INTERRUPT_WAIT)
      } finally {
        order.push('write fails')
        held.reject(new Error(MALFORMED))
      }

      expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(order).toEqual(['stop', 'write fails'])
      expectReported(failed)
    }
  )

  // A provider whose Stop ends its session: the child's end, in the Stop's next step, goes out
  // before the write settles too; that step holds the lane for the Stop event instead.
  it.each([
    ['withdrawing the queued sends', 'withdrawal'],
    ['writing its Stop event', 'event row']
  ] as const)(
    "ends a session-ending provider's child before %s settles, then reports its failure",
    async (step, failed) => {
      const journal = await runningTurn()
      const order: string[] = []
      const closeSession = vi.fn(async () => {
        order.push('kill')
        return true
      })
      Object.assign(host.deps.adapter, { stopEndsSession: () => true, closeSession })
      const held = Promise.withResolvers<never>()
      if (step === 'withdrawing the queued sends') {
        vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(() => held.promise)
      } else {
        vi.spyOn(journal, 'appendStopEvent').mockImplementation(() => held.promise)
      }
      cancelTurn.mockImplementation(async () => {
        order.push('interrupt')
        return { cancelled: true }
      })

      const stopping = stop(fields)
      try {
        await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce(), INTERRUPT_WAIT)
      } finally {
        order.push('write fails')
        held.reject(new Error(MALFORMED))
      }

      expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(order).toEqual(['interrupt', 'kill', 'write fails'])
      await vi.waitFor(() => expectReported(failed))
    }
  )
})
