// A child that reported it is not signed in is replaced before the next send, so a sign-in made
// since reaches a new child; an agent that read its login once at start would fail again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  acceptedDispatch,
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  retireSignedOutStructuredAgentSessionChild,
  structuredAgentSessionChildReportedSignedOut
} from './structured-agent-session-signed-out-child'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionChildWorkReads } from './structured-agent-session-idle-sweep'

describe('a send after the agent said it is not signed in', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  it('goes to a new agent, and the new agent is kept for the sends after it', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('signed out', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    rig.adapter.closeSession.mockClear()

    expect((await rig.host.send(CALLER, restTestSend('signed in now', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)

    // The earlier child's report does not follow the new one.
    expect((await rig.host.send(CALLER, restTestSend('and again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps the agent after any other rejection', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('refused', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    rig.adapter.dispatch.mockImplementation(async () => acceptedDispatch())

    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
  })
})

type Row = { itemId: string; fence: number; agentId?: string; body: AgentJournalItemBody }

const statusRow = (
  fence: number,
  kind: 'notSignedIn' | 'providerExited',
  agentId?: string
): Row => ({
  itemId: `status-${fence}-${kind}-${agentId ?? 'root'}`,
  fence,
  ...(agentId ? { agentId } : {}),
  body: {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'row' })
  }
})
const rejected = (fence: number) => ({
  fence,
  dispatchState: 'rejected' as const,
  rejection: agentSessionFailureFact('notSignedIn')
})
const childAt = (
  overrides: Partial<StructuredAgentSessionProviderChild> = {}
): StructuredAgentSessionProviderChild => ({
  generation: 'generation-2',
  fence: 2,
  phase: 'ready',
  ...overrides
})
const conversation = (
  input: {
    child?: StructuredAgentSessionProviderChild | null
    items?: Row[]
    submissions?: ReturnType<typeof rejected>[]
    activeTurnId?: string
    newestTurnEndedAt?: number
  } = {}
) => {
  const items = input.items ?? []
  return {
    child: input.child === undefined ? childAt() : input.child,
    journal: {
      submissions: () => input.submissions ?? [],
      visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
        items.forEach((item, index) => visit(item.itemId, index, item.body)),
      visitItemsWithLinkage: (visit: JournalItemLinkageVisitor) =>
        items.forEach((item, index) =>
          visit(item.itemId, index, item.body, item.agentId ? { agentId: item.agentId } : {})
        ),
      itemFence: (itemId: string) => items.find((item) => item.itemId === itemId)?.fence,
      activeTurnId: () => input.activeTurnId ?? null,
      newestTurn: (): AgentJournalTurnLifecycle | null =>
        input.newestTurnEndedAt === undefined
          ? null
          : { turnId: 'turn-0', state: 'completed', completedAt: input.newestTurnEndedAt }
    }
  }
}

describe('structuredAgentSessionChildReportedSignedOut', () => {
  const reported = (input: Parameters<typeof conversation>[0]) =>
    structuredAgentSessionChildReportedSignedOut(conversation(input))

  it('reads a not-signed-in row the running child wrote', () => {
    expect(reported({ items: [statusRow(2, 'notSignedIn')] })).toBe(true)
  })

  it('ignores one an earlier child or a subagent wrote, and any other failure', () => {
    expect(reported({ items: [statusRow(1, 'notSignedIn')] })).toBe(false)
    expect(reported({ items: [statusRow(2, 'notSignedIn', 'subagent-1')] })).toBe(false)
    expect(reported({ items: [statusRow(2, 'providerExited')] })).toBe(false)
  })

  it('reads a send rejected as not signed in at this child, not at an earlier one', () => {
    expect(reported({ submissions: [rejected(2)] })).toBe(true)
    expect(reported({ submissions: [rejected(1)] })).toBe(false)
  })

  it('leaves a child that is starting, closing, or absent', () => {
    const items = [statusRow(2, 'notSignedIn')]
    expect(reported({ items, child: childAt({ phase: 'starting' }) })).toBe(false)
    expect(reported({ items, child: null })).toBe(false)
  })
})

describe('retireSignedOutStructuredAgentSessionChild', () => {
  const liveChildWork: AgentChildWorkView = {
    id: 'subagent-1',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 0,
    observedAt: 0,
    stoppable: false,
    invocation: { invocationId: 'spawn-subagent-1', generation: 1 }
  }
  const idle: StructuredAgentSessionChildWorkReads = {
    childWork: () => [],
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false
  }
  const signedOut = { submissions: [rejected(2)] }
  const retire = async (
    input: Parameters<typeof conversation>[0],
    work: Partial<typeof idle> = {},
    stopAgent = vi.fn(async () => undefined)
  ) => {
    const warn = vi.fn()
    await retireSignedOutStructuredAgentSessionChild('session', conversation(input), {
      work: { ...idle, ...work },
      stopAgent,
      logger: { warn, error: vi.fn() }
    })
    return { stopAgent, warn }
  }

  it('stops a signed-out child that owes nothing', async () => {
    expect((await retire(signedOut)).stopAgent).toHaveBeenCalledWith('session')
  })

  it('keeps it while it owes work the idle sweep also protects', async () => {
    // A pending prompt is the shared check's too; the idle sweep's tests cover that case.
    for (const kept of [
      await retire({ ...signedOut, activeTurnId: 'turn-1' }),
      await retire(signedOut, { childWork: () => [liveChildWork] }),
      await retire(signedOut, { hasOpenDispatch: () => true }),
      await retire(signedOut, { providerHoldsDispatch: () => true })
    ]) {
      expect(kept.stopAgent).not.toHaveBeenCalled()
    }
  })

  it('keeps it while a result that settled after the last turn may still wake it', async () => {
    const settled: AgentChildWorkView = {
      ...liveChildWork,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 200
    }
    const after = await retire(
      { ...signedOut, newestTurnEndedAt: 100 },
      { childWork: () => [settled] }
    )
    expect(after.stopAgent).not.toHaveBeenCalled()
    const before = await retire(
      { ...signedOut, newestTurnEndedAt: 300 },
      { childWork: () => [settled] }
    )
    expect(before.stopAgent).toHaveBeenCalledWith('session')
  })

  it('logs a stop that fails and lets the send go on', async () => {
    const { warn } = await retire(
      signedOut,
      {},
      vi.fn(async () => {
        throw new Error('exit not proven')
      })
    )
    expect(warn).toHaveBeenCalledWith(
      'replacing a signed-out agent failed',
      expect.objectContaining({ sessionId: 'session' })
    )
  })
})
