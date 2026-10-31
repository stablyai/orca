import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import {
  createReceivingAccountFixture,
  RECEIVING_A,
  SELECTED_B
} from './structured-agent-session-receiving-account.test-support'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

const ordinary: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'next ordinary input' }]
}

describe('receiving account through native work and exact parent disposition', () => {
  it.each(['current_delivery', 'legacy_direct'] as const)(
    'retains A from creation through %s response, then eligible ordinary follows B',
    async (contract) => {
      const f = await createReceivingAccountFixture()
      try {
        const target = async () =>
          structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
        const child = f.start()
        expect((await target()).home).toEqual(RECEIVING_A)
        const message = f.finish(child, contract)
        expect((await target()).home).toEqual(RECEIVING_A)
        const next = await f.submit(f.body(message), 'host', contract === 'legacy_direct')
        f.db.markAsDelivered([message.id], `run:${f.run.id}`)
        await f.turn(next.clientMessageId, 'running', contract === 'legacy_direct')
        expect((await target()).home).toEqual(RECEIVING_A)
        f.db.markAsRead([message.id])
        expect((await target()).home).toEqual(RECEIVING_A)
        await f.turn('unrelated-parent-request', 'completed')
        expect((await target()).home).toEqual(RECEIVING_A)
        await f.turn(next.clientMessageId, 'completed', contract === 'legacy_direct')
        expect((await target()).home).toEqual(SELECTED_B)
        const picked = await f.submit(ordinary, 'client')
        expect(
          (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, picked)).recipe
        ).toBeUndefined()
        // Repeated unread notice replays cannot recreate account ownership after the exact response.
        f.db.markAsUndelivered([message.id])
        expect((await target()).home).toEqual(SELECTED_B)
      } finally {
        await f.dispose()
      }
    }
  )

  it('retires owed ownership when a rewind retires the Orca send that carried the notice', async () => {
    const f = await createReceivingAccountFixture()
    try {
      const target = () => structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
      const receipt = { write: () => undefined, committed: () => undefined }
      await f.journal.context.clear(
        { operationId: 'clear-1', afterFence: 1, clearedAt: 1 },
        receipt
      )
      const floor = f.journal.cursor()
      const message = f.finish(f.start())
      const next = await f.submit(f.body(message))
      f.db.markAsDelivered([message.id], `run:${f.run.id}`)
      await f.turn(next.clientMessageId, 'running')
      expect((await target()).home).toEqual(RECEIVING_A)
      await f.journal.context.rewind(floor, 2, [], () => receipt)
      expect(f.journal.submission(next.clientMessageId)).toBeUndefined()
      expect((await target()).home).toEqual(SELECTED_B)
    } finally {
      await f.dispose()
    }
  })

  it.each(['interrupted', 'unverifiable'] as const)(
    'keeps existing %s disposition without a success-only hold',
    async (state) => {
      const f = await createReceivingAccountFixture()
      try {
        const message = f.finish(f.start())
        const next = await f.submit(f.body(message))
        const target = () => structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
        expect((await target()).home).toEqual(RECEIVING_A)
        await f.turn(next.clientMessageId, state)
        expect((await target()).home).toEqual(SELECTED_B)
      } finally {
        await f.dispose()
      }
    }
  )

  it('retains known recipe after true absence; unknown historical absence uses selection, without inventing A', async () => {
    const f = await createReceivingAccountFixture()
    try {
      const next = await f.submit(f.body(f.finish(f.start())))
      await f.store.reconcileOnRestart({
        sessionId: f.root,
        probe: async () => ({ outcome: 'exit-observed' }),
        now: 40_000
      })
      f.session.child = null
      const released = f.store.getRecord(f.root)
      if (!released) {
        throw new Error('record missing after actual release')
      }
      const known = await structuredAgentSessionReceivingAccount(f.deps, released, f.session, next)
      expect(known.home).toEqual(RECEIVING_A)
      expect(known.recipe).toMatchObject({ route: 'system', home: RECEIVING_A.path })
      const { acquiredAccount: _observation, ...historical } = released
      // The store reader returns this historical record rather than a retained source observation.
      const lineageRecords = vi.spyOn(f.store, 'lineageRecords').mockReturnValue([historical])
      expect(
        await structuredAgentSessionReceivingAccount(f.deps, historical, f.session, next)
      ).toEqual({ home: SELECTED_B })
      lineageRecords.mockRestore()
    } finally {
      await f.dispose()
    }
  })

  it('fences a previous consumer through the real Run rebind owner', async () => {
    const f = await createReceivingAccountFixture()
    try {
      f.start()
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)).home
      ).toEqual(RECEIVING_A)
      const next = f.db.createRun({
        objective: 'new coordinator consumer',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: f.root
      })
      // Creation keeps the earlier consumer; run-use is the real rebind owner.
      f.db.bindRun({
        runId: next.id,
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: f.root
      })
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)).home
      ).toEqual(SELECTED_B)
    } finally {
      await f.dispose()
    }
  })

  it('signed-out native mail uses existing selected-route recovery, including reacquisition', async () => {
    const f = await createReceivingAccountFixture()
    try {
      const next = await f.submit(f.body(f.finish(f.start())))
      await f.journal.appendItem(
        { provider: 'orca', clientMessageId: 'signed-out' },
        {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'row' })
        },
        { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(
        await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, next)
      ).toEqual({ home: SELECTED_B })
      f.session.child = null
      expect(
        await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, next)
      ).toEqual({ home: SELECTED_B })
    } finally {
      await f.dispose()
    }
  })

  it('allows explicit latest usage-cut recovery without automatically rerouting native mail', async () => {
    const f = await createReceivingAccountFixture()
    try {
      f.start()
      const turnId = await f.turn('limited', 'completed')
      await f.journal.appendItem(
        { provider: 'claude', sessionId: 'parent-provider', uuid: 'turn-limited' },
        {
          kind: 'turn',
          turnId: 'turn-limited',
          state: 'completed',
          outcome: 'failure',
          userItemId: agentJournalSubmissionKey('limited')
        },
        { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await f.journal.appendItem(
        { provider: 'orca', clientMessageId: 'usage' },
        {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), {
            surface: 'row'
          })
        },
        { fence: 2, turnScope: { kind: 'turn', turnItemId: turnId } }
      )
      const next = await f.submit(ordinary, 'client')
      expect(
        await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, next)
      ).toEqual({ home: SELECTED_B })
      await f.turn(next.clientMessageId, 'completed')
      const afterRecovery = await f.submit(ordinary, 'client')
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, afterRecovery))
          .home
      ).toEqual(RECEIVING_A)
      const automatic = await f.submit(f.body(f.finish(f.start())))
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session, automatic)).home
      ).toEqual(RECEIVING_A)
    } finally {
      await f.dispose()
    }
  })
  it('ends pre-notice ownership when the actual created worker is stopped', async () => {
    const f = await createReceivingAccountFixture()
    try {
      const child = f.start()
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)).home
      ).toEqual(RECEIVING_A)
      f.db.reconcileFederatedWorkerStart({
        dispatchId: child.dispatch.id,
        state: 'ready',
        stage: 'ready'
      })
      expect(f.db.beginWorkerStop(child.dispatch.id, 'test-runtime').disposition).toBe('stopping')
      f.db.settleWorkerStop(child.dispatch.id)
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)).home
      ).toEqual(SELECTED_B)
    } finally {
      await f.dispose()
    }
  })
  it("does not add an account hold to main's accepted-but-unanswered ended generation", async () => {
    const f = await createReceivingAccountFixture()
    try {
      const message = f.finish(f.start())
      const next = await f.submit(f.body(message), 'host', true)
      await f.journal.resolveDispatch({
        clientMessageId: next.clientMessageId,
        fence: 2,
        state: 'accepted',
        providerIdentity: {
          provider: 'claude',
          sessionId: 'parent-provider',
          uuid: 'unanswered-echo'
        }
      })
      f.db.markAsDelivered([message.id], `run:${f.run.id}`)
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)).home
      ).toEqual(RECEIVING_A)
      await f.store.reconcileOnRestart({
        sessionId: f.root,
        probe: async () => ({ outcome: 'exit-observed' }),
        now: 40_000
      })
      f.session.child = null
      const released = f.store.getRecord(f.root)
      if (!released) {
        throw new Error('record missing after execution ended')
      }
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, released, f.session)).home
      ).toEqual(SELECTED_B)
      expect(f.journal.submission(next.clientMessageId)?.dispatchState).toBe('accepted')
      // A distinct later result still has known receiving A; this does not erase the actual recipe.
      f.finish(f.start())
      expect(
        (await structuredAgentSessionReceivingAccount(f.deps, released, f.session)).home
      ).toEqual(RECEIVING_A)
    } finally {
      await f.dispose()
    }
  })
})
