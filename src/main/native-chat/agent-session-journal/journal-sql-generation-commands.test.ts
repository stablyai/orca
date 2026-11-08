import { expect, it } from 'vitest'
import { journalInputOrder } from './input-order/journal-input-order'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  JournalStaleSettlementInput,
  JournalDeadGenerationSettlementInput
} from './journal-store-contracts'
import {
  settleJournalStaleState,
  settleJournalDeadGeneration
} from './writing/journal-generation-settlement'
import { journalGenerationSettlementRead } from './writing/journal-generation-settlement-read'
import { renderJournalStatus } from './projection/journal-public-read'
import { mutateJournalPrompt } from './writing/journal-prompt-mutation'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { journalStopEventRowBuilder } from './context-epochs/journal-stop-and-resume-rows'

import {
  sides,
  both,
  saved,
  type memoryJournal,
  text
} from './journal-sql-input-command.test-fixture'

const promptIdentity = { provider: 'orca' as const, clientMessageId: 'approval' }
const promptId = agentJournalItemKey(promptIdentity)
const pendingApproval = {
  kind: 'approval' as const,
  title: 'Run?',
  detail: null,
  options: [{ id: 'allow', label: 'Allow' }],
  resolution: {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

function settlementRead(j: ReturnType<typeof memoryJournal>) {
  return journalGenerationSettlementRead(
    () => j.state(),
    j,
    () => renderJournalStatus(j.queuedMessages.displayState(), journalInputOrder(j.state())).items
  )
}

it('rechecks prompt mutations after provider revisions and preserves the accepted answer during stale settlement', async () => {
  const side = await sides()
  const scope = { kind: 'thread' as const }
  await both(
    side,
    (j) => j.itemAppender.append(promptIdentity, pendingApproval, { fence: 1, turnScope: scope }),
    {
      kind: 'item',
      identity: promptIdentity,
      body: pendingApproval,
      options: { fence: 1, turnScope: scope }
    }
  )
  const answer = {
    itemId: promptId,
    expectedRevision: 1,
    kind: 'approval' as const,
    resolution: {
      state: 'resolved' as const,
      selectedOptionId: 'allow',
      resolvedBy: 'person',
      resolvedAt: 900
    },
    options: { fence: 1, turnScope: scope }
  }
  await both(
    side,
    (j) => mutateJournalPrompt({ state: () => j.state(), writer: j.rowWriter }, answer),
    {
      kind: 'prompt-mutate',
      input: answer
    }
  )
  const before = saved(side.sqlDb)
  await expect(
    side.run({
      kind: 'prompt-mutate',
      input: {
        ...answer,
        resolution: {
          state: 'cancelled',
          selectedOptionId: null,
          resolvedBy: 'person',
          resolvedAt: 950
        }
      }
    })
  ).rejects.toMatchObject({ refusal: { code: 'agent_session_item_revision_stale' } })
  expect(saved(side.sqlDb)).toEqual(before)
  const stale: JournalStaleSettlementInput = {
    sessionId: 'session',
    fence: 2,
    acquisitionGeneration: 'new',
    deathEvidence: null
  }
  await both(
    side,
    (j) => settleJournalStaleState(settlementRead(j), j.lifecycleBatchAppender, stale),
    {
      kind: 'stale-settle',
      input: stale
    }
  )
  expect(side.memory.state().items.get(promptId)?.body).toMatchObject({
    resolution: { state: 'resolved', selectedOptionId: 'allow', resolvedAt: 900 }
  })
})

it('settles stale lifecycle records and later proof identically without changing unrelated history', async () => {
  const side = await sides()
  const turn = { provider: 'orca' as const, clientMessageId: 'stale-turn' }
  const running = agentJournalTurnBody({ turnId: 'stale-turn', state: 'running', startedAt: 100 })
  for (const [identity, body] of [
    [turn, running],
    [promptIdentity, pendingApproval]
  ] as const) {
    await both(
      side,
      (j) => j.itemAppender.append(identity, body, { fence: 1, turnScope: { kind: 'thread' } }),
      {
        kind: 'item',
        identity,
        body,
        options: { fence: 1, turnScope: { kind: 'thread' } }
      }
    )
  }
  const stale: JournalStaleSettlementInput = {
    sessionId: 'session',
    fence: 2,
    acquisitionGeneration: 'reopened',
    deathEvidence: null
  }
  await both(
    side,
    (j) => settleJournalStaleState(settlementRead(j), j.lifecycleBatchAppender, stale),
    {
      kind: 'stale-settle',
      input: stale
    }
  )
  expect(side.memory.state().items.get(agentJournalItemKey(turn))?.body).toMatchObject({
    state: 'unverifiable'
  })
  expect(side.memory.state().items.get(promptId)?.body).toMatchObject({
    resolution: { state: 'cancelled' }
  })
  const proof: JournalStaleSettlementInput = {
    ...stale,
    acquisitionGeneration: 'proof',
    deathEvidence: { kind: 'exit-observed', detail: '', ownerFence: 1, observedAt: 800 }
  }
  await both(
    side,
    (j) => settleJournalStaleState(settlementRead(j), j.lifecycleBatchAppender, proof),
    {
      kind: 'stale-settle',
      input: proof
    }
  )
  expect(side.memory.state().items.get(agentJournalItemKey(turn))?.body).toMatchObject({
    state: 'interrupted',
    completedAt: 800
  })
  const before = saved(side.sqlDb)
  await side.run({ kind: 'stale-settle', input: proof })
  expect(saved(side.sqlDb)).toEqual(before)
})

it('settles dead and older generations together while honoring volatile handover ownership', async () => {
  const side = await sides()
  for (const [id, fence] of [
    ['old', 1],
    ['exited', 2],
    ['continuing', 2]
  ] as const) {
    const input = { clientMessageId: id, payloadFingerprint: id, body: text(id), fence }
    await both(side, (j) => j.submissionWriter.append(input), { kind: 'submission', input })
  }
  const input: JournalDeadGenerationSettlementInput = {
    sessionId: 'session',
    fence: 3,
    below: 2,
    deathEvidence: null,
    exit: {
      ownerFence: 2,
      settlementId: 'exit',
      verdict: { state: 'interrupted', completedAt: 800 },
      pendingSubmissionReason: 'provider_exited',
      showUnexpectedExitOutcome: false
    },
    continuingInputs: ['continuing'],
    finalizingInputs: []
  }
  await both(
    side,
    (j) => settleJournalDeadGeneration(settlementRead(j), j.lifecycleBatchAppender, input),
    {
      kind: 'dead-generation-settle',
      input
    }
  )
  expect(
    ['old', 'exited', 'continuing'].map(
      (id) => side.memory.state().submissions.get(id)?.dispatchState
    )
  ).toEqual(['unknown', 'unknown', 'pending'])
})

it('does not report an unexpected exit for sends held by their result owners', async () => {
  const side = await sides()
  for (const id of ['continuing', 'own-finalizer']) {
    const submission = { clientMessageId: id, payloadFingerprint: id, body: text(id), fence: 1 }
    await both(side, (j) => j.submissionWriter.append(submission), {
      kind: 'submission',
      input: submission
    })
  }
  const input: JournalDeadGenerationSettlementInput = {
    sessionId: 'session',
    fence: 2,
    below: 1,
    deathEvidence: null,
    exit: {
      ownerFence: 1,
      settlementId: 'exit',
      verdict: { state: 'unverifiable' },
      pendingSubmissionReason: 'provider_exited'
    },
    continuingInputs: ['continuing'],
    finalizingInputs: [{ clientMessageId: 'own-finalizer', settlementOwner: true }]
  }
  await both(
    side,
    (j) => settleJournalDeadGeneration(settlementRead(j), j.lifecycleBatchAppender, input),
    {
      kind: 'dead-generation-settle',
      input
    }
  )
  expect(side.memory.state().submissions.get('own-finalizer')?.dispatchState).toBe('unknown')
  expect(side.memory.state().submissions.get('continuing')?.dispatchState).toBe('pending')
  expect(
    settlementRead(side.memory)
      .statusRead()
      .items.filter((item) => item.body.kind === 'status')
  ).toEqual([])
})

it('keeps an in-flight personal Stop authoritative for cancellation and notice suppression', async () => {
  const side = await sides()
  const { memory } = side
  const turn = { provider: 'orca' as const, clientMessageId: 'stopping-turn' }
  await memory.itemAppender.append(
    turn,
    agentJournalTurnBody({ turnId: 'turn', state: 'running', startedAt: 100 }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await memory.rowWriter.append(
    journalStopEventRowBuilder(() => memory.state(), { reason: 'user-stop' }, 1)
  )
  memory.stopMarks.beginSettle(true)
  await settleJournalStaleState(settlementRead(memory), memory.lifecycleBatchAppender, {
    sessionId: 'session',
    fence: 2,
    acquisitionGeneration: 'stopped',
    deathEvidence: { kind: 'exit-observed', detail: '', ownerFence: 1, observedAt: 1200 }
  })
  expect(memory.state().items.get(agentJournalItemKey(turn))?.body).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation'
  })
  expect(
    settlementRead(memory)
      .statusRead()
      .items.filter((item) => item.body.kind === 'status')
  ).toEqual([])
})
