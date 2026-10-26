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
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildReportedSignedOut
} from './structured-agent-session-outgrown-child'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'

describe('a send after the agent said it is not signed in', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  it('recovers a signed-out child for mail after sign-in, then reuses the new child', async () => {
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

    const mail = restTestSend('signed in now: worker mail', fence())
    mail.body.from = {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'agent:worker',
        dispatchId: null,
        messages: []
      }
    }
    expect((await rig.host.send(CALLER, mail)).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)

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
      itemBody: (itemId: string) => items.find((item) => item.itemId === itemId)?.body ?? null,
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

describe('retireOutgrownStructuredAgentSessionChild', () => {
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
  const idle: Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2]['work'] = {
    currentWork: () => ({ activeTurnId: () => null, hasActionablePrompt: () => false }),
    childWork: () => [],
    childWorkOpen: () => false,
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false
  }
  const owing = (turnId: string | null, prompt: boolean): Partial<typeof idle> => ({
    currentWork: () => ({ activeTurnId: () => turnId, hasActionablePrompt: () => prompt })
  })
  const signedOut = { submissions: [rejected(2)] }
  const retire = async (
    input: Parameters<typeof conversation>[0],
    work: Partial<typeof idle> = {},
    stopAgent = vi.fn(async () => undefined),
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>
  ) => {
    const warn = vi.fn()
    await retireOutgrownStructuredAgentSessionChild('session', conversation(input), {
      work: { ...idle, ...work },
      ...(launchPermission ? { launchPermission } : {}),
      stopAgent,
      logger: { warn, error: vi.fn() }
    })
    return { stopAgent, warn }
  }

  it('stops a signed-out child that owes nothing', async () => {
    expect((await retire(signedOut)).stopAgent).toHaveBeenCalledWith('session')
  })

  it('keeps it while it owes work the idle sweep also protects', async () => {
    for (const kept of [
      await retire(signedOut, owing('turn-1', false)),
      await retire(signedOut, { childWorkOpen: () => true }),
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

  it('says why a model change waits, reading wake debt only when open work leaves that open', async () => {
    const settled: AgentChildWorkView = {
      ...liveChildWork,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 200
    }
    const refuse = async (work: Partial<typeof idle>, children: AgentChildWorkView[]) => {
      const childWork = vi.fn(() => children)
      const refusal = await retireOutgrownStructuredAgentSessionChild(
        'session',
        conversation({ newestTurnEndedAt: 100 }),
        {
          work: { ...idle, childWork, ...work },
          next: {
            clientMessageId: 'next',
            fence: 2,
            payloadFingerprint: 'next',
            dispatchState: 'pending',
            providerItemId: null,
            reason: null,
            submittedAt: 0,
            resolvedAt: null
          },
          requiresModelTransitionRestart: () => true,
          stopAgent: vi.fn(async () => undefined),
          logger: { warn: vi.fn(), error: vi.fn() }
        }
      )
      return { refusal, wakeDebtReads: childWork.mock.calls.length }
    }
    const waits = (reason: string, wakeDebtReads: number) => ({
      refusal: { details: { reason } },
      wakeDebtReads
    })
    expect(await refuse({ childWorkOpen: () => true }, [settled])).toMatchObject(
      waits('backgroundTasksRunning', 0)
    )
    expect(await refuse({}, [settled])).toMatchObject(waits('backgroundTasksRunning', 1))
    expect(await refuse({ providerHoldsDispatch: () => true }, [settled])).toMatchObject(
      waits('backgroundTasksRunning', 1)
    )
    expect(await refuse({ providerHoldsDispatch: () => true }, [])).toMatchObject(
      waits('messagesUnsettled', 1)
    )
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
      'replacing an outgrown agent failed',
      expect.objectContaining({ sessionId: 'session' })
    )
  })

  describe('a child launched with another permission mode', () => {
    const now = (mode: AgentChatPermissionChoice) => vi.fn(async () => mode)
    const askChild = { child: childAt({ permissionMode: 'ask' }) }

    it('is stopped once, and one launched with the current mode is kept', async () => {
      expect(
        (await retire(askChild, {}, undefined, now('full-access'))).stopAgent
      ).toHaveBeenCalledWith('session')
      expect((await retire(askChild, {}, undefined, now('ask'))).stopAgent).not.toHaveBeenCalled()
    })

    it('is kept while it owes work, as a signed-out one is', async () => {
      for (const kept of [
        await retire(askChild, owing('turn-1', false), undefined, now('auto')),
        await retire(askChild, { childWorkOpen: () => true }, undefined, now('auto')),
        await retire(askChild, owing(null, true), undefined, now('auto'))
      ]) {
        expect(kept.stopAgent).not.toHaveBeenCalled()
      }
    })

    it('is kept while starting, or for an agent with no modes', async () => {
      const starting = { child: childAt({ permissionMode: 'ask', phase: 'starting' }) }
      expect((await retire(starting, {}, undefined, now('auto'))).stopAgent).not.toHaveBeenCalled()
      expect(
        (await retire(askChild, {}, undefined, async () => null)).stopAgent
      ).not.toHaveBeenCalled()
    })

    it('never reads the mode for a child launched with none', async () => {
      const current = now('full-access')
      expect((await retire({}, {}, undefined, current)).stopAgent).not.toHaveBeenCalled()
      expect(current).not.toHaveBeenCalled()
    })
  })
})
