// A child the chat outgrew is replaced before the next send: one that reported it is not signed in,
// so a sign-in made since reaches a new child, and one launched with a permission mode the chat no
// longer has, so the new mode reaches a new child.

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
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
    launchPermission?: () => Promise<AgentChatPermissionMode | null>
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
    // A pending prompt is the shared check's too; the idle sweep's tests cover that case.
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
    const now = (mode: AgentChatPermissionMode) => vi.fn(async () => mode)
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

    // The check reads the same mode a start launches with, so each start ends the restarts.
    describe('against the mode a start launches with', () => {
      // The saved catalog the probe keeps from `claude` 2.1.280: the default row folded into the
      // row it resolves to, every row but haiku listed as running auto.
      const listed = [
        { id: 'opus[1m]', isDefault: true, supportsAutoMode: true },
        { id: 'sonnet', isDefault: false, supportsAutoMode: true },
        { id: 'haiku', isDefault: false }
      ]
      const catalog = (rows: typeof listed) => ({
        peek: () => null,
        read: vi.fn(async () => ({
          origin: 'probe' as const,
          fetchedAt: 1,
          models: rows.map((row) => ({ ...row, label: row.id, efforts: [] }))
        })),
        retainedLiveModelIds: vi.fn(async () => []),
        recordLiveListing: vi.fn(),
        prewarm: vi.fn(async () => undefined),
        stop: vi.fn(),
        providerStarted: vi.fn()
      })
      const launch = ({ permissionMode, ...options }: Record<string, string>, rows = listed) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent, options and mode.
        const record = {
          sessionId: 'session',
          provider: 'claude',
          options,
          permissionMode
        } as AgentSessionRecord
        return () =>
          structuredAgentSessionLaunchPermission(
            { agents: claudeAndCodexDeclared(), modelCatalog: catalog(rows) },
            record
          )
      }
      const stoppedAfterLaunch = async (
        launched: AgentChatPermissionMode,
        current: () => Promise<AgentChatPermissionMode | null>
      ) =>
        (await retire({ child: childAt({ permissionMode: launched }) }, {}, undefined, current))
          .stopAgent.mock.calls.length > 0

      it('restarts Full access or Accept edits into Ask when auto is not confirmed', async () => {
        const unconfirmed = [
          launch({ model: 'haiku', permissionMode: 'auto' }),
          launch({ permissionMode: 'auto' }, [{ id: 'opus[1m]', isDefault: true }])
        ]
        for (const autoPick of unconfirmed) {
          await expect(autoPick()).resolves.toBe('ask')
          expect(await stoppedAfterLaunch('full-access', autoPick)).toBe(true)
          expect(await stoppedAfterLaunch('accept-edits', autoPick)).toBe(true)
          expect(await stoppedAfterLaunch('ask', autoPick)).toBe(false)
        }
      })

      it('never restarts a child it just started, from an alias or a resolved id', async () => {
        const records: Record<string, string>[] = [
          { permissionMode: 'auto' },
          { model: 'default', permissionMode: 'auto' },
          { model: 'opus[1m]', permissionMode: 'auto' },
          { model: 'sonnet', permissionMode: 'auto' },
          { model: 'haiku', permissionMode: 'auto' },
          { model: 'claude-opus-5-5[1m]', permissionMode: 'auto' }
        ]
        const runsAuto = [true, true, true, true, false, false]
        for (const [index, options] of records.entries()) {
          const current = launch(options)
          const launched = await current()
          expect(launched).toBe(runsAuto[index] ? 'auto' : 'ask')
          expect(await stoppedAfterLaunch(launched!, current)).toBe(false)
        }
      })

      // A resolved id launches Ask; the start reports the listed alias, so one restart reaches auto.
      it('settles after one restart once a resolved id is reported as its alias', async () => {
        const first = await launch({ model: 'claude-opus-5-5[1m]', permissionMode: 'auto' })()
        const reported = launch({ model: 'opus[1m]', permissionMode: 'auto' })
        expect(await stoppedAfterLaunch(first!, reported)).toBe(true)
        expect(await stoppedAfterLaunch((await reported())!, reported)).toBe(false)
      })
    })

    it('never reads the mode for a child launched with none', async () => {
      const current = now('full-access')
      expect((await retire({}, {}, undefined, current)).stopAgent).not.toHaveBeenCalled()
      expect(current).not.toHaveBeenCalled()
    })
  })
})
