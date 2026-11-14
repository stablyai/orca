import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { createFixture } from '../../agent-session-journal/store-lifecycle/journal-store-contract-test-fixture'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from '../recovery/structured-agent-session-usage-limit-chain'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

const fixture = createFixture()

async function limitedTurn(
  journal: AgentSessionJournal,
  name: string,
  rows: number,
  opened: { userItemId?: string; resetsAt?: number } = {}
) {
  const turn = await journal.appendItem(
    { provider: 'orca', clientMessageId: `turn-${name}` },
    {
      kind: 'turn',
      turnId: name,
      state: 'completed',
      outcome: 'failure',
      completedAt: 1,
      ...(opened.userItemId ? { userItemId: opened.userItemId } : {})
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const scope = { fence: 1, turnScope: { kind: 'turn' as const, turnItemId: turn.itemId } }
  for (let index = 0; index < rows; index += 1) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `${name}-output-${index}` },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'working' }] },
      scope
    )
  }
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `${name}-limit` },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          usageLimit: { resetsAt: opened.resetsAt ?? 60_000 }
        }),
        { surface: 'row' }
      )
    },
    scope
  )
  return scope
}

async function hostContinue(
  journal: AgentSessionJournal,
  cut: { turnItemId: string; resetsAt: number },
  at: number
) {
  const clientMessageId = usageLimitContinueMessageId(
    at,
    usageLimitContinueTag(cut),
    '0123456789abcdef'
  )
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: `continue-${at}`,
    body: { kind: 'message', role: 'user', blocks: [] },
    origin: 'host',
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    fence: 1
  })
  return clientMessageId
}

/** A limited turn and one automatic continue that hits the limit again. */
async function chainOfOne(journal: AgentSessionJournal, rows: number) {
  const first = await limitedTurn(journal, 'first', rows)
  const sent = await hostContinue(
    journal,
    { turnItemId: first.turnScope.turnItemId, resetsAt: 60_000 },
    2_000
  )
  await journal.resolveDispatch({
    clientMessageId: sent,
    state: 'accepted',
    providerIdentity: null,
    fence: 1
  })
  return limitedTurn(journal, 'second', rows, {
    userItemId: agentJournalSubmissionKey(sent),
    resetsAt: 120_000
  })
}

async function readProjection(
  projections: StructuredAgentSessionJournalProjections,
  journal: AgentSessionJournal
) {
  return projections.readSql(
    journal,
    () => ({
      contextId: null,
      authority: {
        handle: journal.observationHandle(),
        record: null,
        child: null,
        handingOver: [],
        continuingUnadmitted: [],
        finalizing: [],
        openedThrough: journal.openingCursor(),
        reopenFloor: null,
        operationalRevision: 0,
        stopRevision: 0,
        stop: null
      }
    }),
    () => {
      throw new Error('unexpected projection invalidation')
    }
  )
}

it('stops counting a link when its earlier usage limit is revised to another reset', async () => {
  const journal = await fixture.open()
  const projections = new StructuredAgentSessionJournalProjections()
  await chainOfOne(journal, 0)
  expect((await readProjection(projections, journal))!.usageLimitCut?.chain).toBe(1)
  // The provider rewrites the first turn's failure under the same row with a later reset.
  const first = (await readProjection(projections, journal))!.usageLimitCut
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'first-limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 90_000 } }),
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn-first' } }
  )
  const revised = (await readProjection(projections, journal))!.usageLimitCut
  expect(revised?.turnItemId).toBe(first?.turnItemId)
  expect(revised?.chain).toBe(0)
})

it.each([
  ['the newest link', 0],
  ['an older link', 1]
])(
  'recounts when a late receipt attributes the opener of %s after its turn ended',
  async (_, laterLinks) => {
    const journal = await fixture.open()
    const projections = new StructuredAgentSessionJournalProjections()
    const first = await limitedTurn(journal, 'first', 0)
    const late = await hostContinue(
      journal,
      { turnItemId: first.turnScope.turnItemId, resetsAt: 60_000 },
      2_000
    )
    await journal.write({ kind: 'pending-unknown', fence: 1 })
    // The provider's echo opens the turn before any receipt names it.
    const echo = { provider: 'orca' as const, clientMessageId: 'provider-echo' }
    await journal.appendItem(
      echo,
      { kind: 'message', role: 'user', blocks: [] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    let cut = await limitedTurn(journal, 'second', 0, {
      userItemId: agentJournalItemKey(echo),
      resetsAt: 120_000
    })
    for (let link = 0; link < laterLinks; link += 1) {
      const sent = await hostContinue(
        journal,
        { turnItemId: cut.turnScope.turnItemId, resetsAt: 120_000 + link * 60_000 },
        3_000 + link
      )
      await journal.resolveDispatch({
        clientMessageId: sent,
        state: 'accepted',
        providerIdentity: null,
        fence: 1
      })
      cut = await limitedTurn(journal, `later-${link}`, 0, {
        userItemId: agentJournalSubmissionKey(sent),
        resetsAt: 180_000 + link * 60_000
      })
    }
    expect((await readProjection(projections, journal))!.usageLimitCut?.chain).toBe(laterLinks)
    await journal.write({
      kind: 'accept-late',
      input: {
        clientMessageId: late,
        state: 'accepted',
        providerIdentity: echo,
        fence: 1
      }
    })
    expect((await readProjection(projections, journal))!.usageLimitCut?.chain).toBe(laterLinks + 1)
  }
)
