import { beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { createFixture } from '../../agent-session-journal/store-lifecycle/journal-store-contract-test-fixture'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type * as UsageLimitChain from '../recovery/structured-agent-session-usage-limit-chain'
import {
  readUsageLimitContinueChain,
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from '../recovery/structured-agent-session-usage-limit-chain'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

vi.mock('../recovery/structured-agent-session-usage-limit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof UsageLimitChain>()
  return { ...actual, readUsageLimitContinueChain: vi.fn(actual.readUsageLimitContinueChain) }
})

const fixture = createFixture()
const derivations = () => vi.mocked(readUsageLimitContinueChain).mock.calls.length
beforeEach(() => {
  vi.mocked(readUsageLimitContinueChain).mockClear()
})

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

it.each([100, 1_000])(
  'derives a cut chain once over %i rows, however many rebuilds follow, and again for a new cut or epoch',
  async (rows) => {
    const journal = await fixture.open()
    const projections = new StructuredAgentSessionJournalProjections()
    const scope = await limitedTurn(journal, 'first', rows)
    expect(projections.read(journal, null).usageLimitCut?.chain).toBe(0)
    // Rows that change nothing the chain reads rebuild the status without walking the journal again.
    for (let index = 0; index < 20; index += 1) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `late-${index}` },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late' }] },
        scope
      )
      expect(projections.read(journal, null).usageLimitCut?.chain).toBe(0)
    }
    expect(derivations()).toBe(1)

    const second = await limitedTurn(journal, 'second', 0)
    expect(projections.read(journal, null).usageLimitCut?.turnItemId).toBe(
      second.turnScope.turnItemId
    )
    expect(derivations()).toBe(2)

    // The same cut identity in a new epoch is a different conversation and is read again.
    await journal.rollEpoch('unreconcilable_prefix', 1)
    await limitedTurn(journal, 'second', 0)
    expect(projections.read(journal, null).usageLimitCut?.turnItemId).toBe(
      second.turnScope.turnItemId
    )
    expect(derivations()).toBe(3)
  }
)

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
    await journal.markPendingSubmissionsUnknown(1)
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
    expect(projections.read(journal, null).usageLimitCut?.chain).toBe(laterLinks)
    await journal.acceptLate({
      clientMessageId: late,
      state: 'accepted',
      providerIdentity: echo,
      fence: 1
    })
    expect(projections.read(journal, null).usageLimitCut?.chain).toBe(laterLinks + 1)
  }
)
