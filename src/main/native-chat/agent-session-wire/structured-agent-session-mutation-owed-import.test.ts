// A mutation reads the fold after every write issued before it, even while a restore's import is
// owed: the open pays the import first, so provider rows queued behind it have landed. A failed
// import is reported and never refuses the mutation.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
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
let warned: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ;({ host, acquire, cancelTurn } = hostTestState())
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function journal(): AgentSessionJournal {
  const open = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('no open journal')
  }
  return open
}

function providerEvents(): StructuredAgentSessionEventSink {
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no provider bound')
  }
  return events
}

/** Owed work standing in for a restore's import: every write waits behind it until it settles. */
function oweImport(): PromiseWithResolvers<void> {
  const owed = Promise.withResolvers<void>()
  journal()['queue'].owe(() => owed.promise)
  return owed
}

/** A turn the provider opened by itself, its row queued behind the owed import. */
function providerOpensTurn(turnId: string, ordinal: number): void {
  providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId, ordinal },
    { kind: 'turn', turnId, state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function stopNamingNoTurn() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

describe('a mutation while an import is owed', () => {
  it('a Stop naming no turn sees the turn the provider opened, and interrupts it', async () => {
    await attach()
    const owed = oweImport()
    providerOpensTurn('turn-p', 900)
    expect(journal().activeTurnId()).toBeNull()

    const stopping = stopNamingNoTurn()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // It waits for the import, as a reader does, then reads the turn.
    expect(cancelTurn).not.toHaveBeenCalled()
    owed.resolve()

    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('a goal set sees the goal and the turn the provider wrote, and replaces it in that turn', async () => {
    await attach()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    Object.assign(host.deps.adapter, { changeThreadGoal, supportsThreadGoal: () => true })
    const owed = oweImport()
    providerOpensTurn('turn-g', 901)
    providerEvents().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-g', ordinal: 902 },
      {
        kind: 'status',
        text: 'Goal',
        threadGoal: {
          state: 'set',
          goal: {
            objective: 'Earlier goal',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 1,
            timeUsedSeconds: 2,
            createdAt: 3_000,
            updatedAt: 4_000
          }
        }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const change = { kind: 'set' as const, objective: 'New goal' }
    const setting = host.changeThreadGoal(CALLER, {
      envelope: envelope('agentSession.threadGoal', { change }),
      change
    })
    // Long enough for the goal set to reach its read before the import lands.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(changeThreadGoal).not.toHaveBeenCalled()
    owed.resolve()

    expect(await setting).toMatchObject({ ok: true })
    expect(changeThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ replacesGoal: true }))
    const objective = journal()
      .snapshot()
      .items.find((item) => item.body.kind === 'message' && item.body.sentAs === 'goal')
    expect(objective?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: expect.stringContaining(':turn-g:')
    })
  })

  it('a failed import is reported and the Stop still answers', async () => {
    await attach()
    const owed = oweImport()
    owed.reject(new Error('disk I/O error'))

    expect(await stopNamingNoTurn()).toMatchObject({ ok: true })
    expect(warned).toHaveBeenCalledWith(
      '[agent-session] open-for-write: the import owed before a write failed',
      expect.objectContaining({ error: new Error('disk I/O error') })
    )
  })
})
