import { it, expect, vi } from 'vitest'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data'
import {
  parseAgentJournalItemKey,
  agentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

it('accepted Stop withdraws first late known-reset cut even when feedback note could not save', async () => {
  const rig = await createQueuedMessageTestRig({ now: () => NOW, restartable: true })
  let restoreAppendItem: (() => void) | undefined
  try {
    const id = await rig.workingSend()
    await rig.settleAccepted(id, '1')
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    const turnIdentity = { provider: 'orca' as const, clientMessageId: 'close2-usage-turn' }
    const turnItemId = agentJournalItemKey(turnIdentity)
    await journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: NOW - 100 },
      { fence, turnScope: { kind: 'thread' } }
    )
    const append = journal.appendItem.bind(journal)
    const spy = vi.spyOn(journal, 'appendItem').mockImplementation((...args) => {
      const item = agentJournalItemKey(args[0])
      const parsed = parseAgentJournalItemKey(item)
      if (parsed?.provider === 'orca' && parsed.clientMessageId.startsWith('stop:')) {
        return Promise.reject(new Error('injected best-effort feedback failure'))
      }
      return append(...args)
    })
    restoreAppendItem = () => spy.mockRestore()
    expect(await rig.stop()).toMatchObject({ ok: true })
    // Exact earlier provider failure must keep its meaning; no limit/reset was known at Stop.
    const endFence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    await journal.appendItem(
      turnIdentity,
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'failure',
        startedAt: NOW - 100,
        completedAt: NOW - 1
      },
      { fence: endFence, turnScope: { kind: 'thread' } }
    )
    expect(journal.stopMarks.cancellations()).toEqual([])
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toBeUndefined()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'late-limit' },
      {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: NOW + 60_000 } }),
          { surface: 'row' }
        )
      },
      { fence: endFence, turnScope: { kind: 'turn', turnItemId } }
    )
    const cut = latestUsageLimitContinueIdentity(await rig.host.journalSnapshot(SESSION))
    expect(cut).toBeDefined()
    expect(rig.store.getRecord(SESSION)?.usageLimitContinueCancel).toEqual(cut)
  } finally {
    restoreAppendItem?.()
    await rig.dispose()
  }
})
