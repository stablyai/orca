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
  hostUsageLimitCut,
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from '../recovery/structured-agent-session-usage-limit-chain'
import {
  chainReads,
  countedItems,
  countedSubmissions
} from '../recovery/structured-agent-session-usage-limit-chain-reads-test-support'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

let reads = chainReads()
vi.mock('../recovery/structured-agent-session-usage-limit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof UsageLimitChain>()
  return {
    ...actual,
    hostUsageLimitCut: vi.fn((...[snapshot, cut]: Parameters<typeof actual.hostUsageLimitCut>) =>
      actual.hostUsageLimitCut(
        {
          items: countedItems(snapshot.items, reads),
          submissions: countedSubmissions(snapshot.submissions, reads)
        },
        cut
      )
    )
  }
})

const fixture = createFixture()
let measured = 0
const derivations = () =>
  vi.mocked(hostUsageLimitCut).mock.calls.filter(([, cut]) => cut !== null).length
beforeEach(() => {
  vi.mocked(hostUsageLimitCut).mockClear()
  reads = chainReads()
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

async function personTurn(journal: AgentSessionJournal, name: string) {
  const clientMessageId = `person-${name}`
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: clientMessageId,
    body: { kind: 'message', role: 'user', blocks: [] },
    origin: 'client',
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    providerIdentity: null,
    fence: 1
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `turn-${name}` },
    {
      kind: 'turn',
      turnId: name,
      state: 'completed',
      outcome: 'success',
      completedAt: 1,
      userItemId: agentJournalSubmissionKey(clientMessageId)
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** A person's limited turn of `rows` rows and one automatic continue that hit the limit again after `rows` more.
 *  `olderRows` puts a long earlier turn first, and the person's turn is then opened by the agent's echo. */
async function chainOfOne(journal: AgentSessionJournal, rows: number, olderRows?: number) {
  let opened: { userItemId?: string } = {}
  if (olderRows !== undefined) {
    await limitedTurn(journal, 'older', olderRows)
    const echo = { provider: 'orca' as const, clientMessageId: 'provider-echo-root' }
    await journal.appendSubmission({
      clientMessageId: 'person-root',
      payloadFingerprint: 'person-root',
      body: { kind: 'message', role: 'user', blocks: [] },
      origin: 'client',
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'person-root',
      state: 'accepted',
      providerIdentity: echo,
      fence: 1
    })
    opened = { userItemId: agentJournalItemKey(echo) }
  }
  const first = await limitedTurn(journal, 'first', rows, opened)
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

it('derives the chain only when the status projection rebuilds', async () => {
  const journal = await fixture.open()
  const projections = new StructuredAgentSessionJournalProjections()
  const cut = await chainOfOne(journal, 0)
  expect(projections.read(journal, null).usageLimitCut?.chain).toBe(1)
  projections.read(journal, null)
  expect(derivations()).toBe(1)
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'late' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late' }] },
    cut
  )
  expect(projections.read(journal, null).usageLimitCut?.chain).toBe(1)
  expect(derivations()).toBe(2)
})

// Bounds come from what the walk must read: the chain's own turns once each way, never the history before it.
it('reads the chain tail linearly, whatever history precedes it', async () => {
  const measure = async (history: number, rows: number, olderRows?: number) => {
    const journal = await fixture.open({
      identity: { ...fixture.IDENTITY, sessionId: `measure-${(measured += 1)}` }
    })
    for (let index = 0; index < history; index += 1) {
      await personTurn(journal, `old-${index}`)
    }
    await chainOfOne(journal, rows, olderRows)
    reads = chainReads()
    const chain = new StructuredAgentSessionJournalProjections().read(journal, null).usageLimitCut
      ?.chain
    return { chain, total: reads.total }
  }
  const short = await measure(50, 0)
  const long = await measure(500, 0)
  expect([short.chain, long.chain]).toEqual([1, 1])
  expect(long.total).toBe(short.total)
  // An echo-opened root names a key no row carries; its opener is still found without reading the turn before.
  const echoed = await measure(0, 0, 50)
  const echoedLong = await measure(0, 0, 500)
  expect([echoed.chain, echoedLong.chain]).toEqual([1, 1])
  expect(echoedLong.total).toBe(echoed.total)
  const rows = await measure(0, 200)
  const tenfold = await measure(0, 2_000)
  expect([rows.chain, tenfold.chain]).toEqual([1, 1])
  // Each of the two turns' rows is read a few fields at a time on one pass back and one pass forward.
  expect(tenfold.total).toBeLessThanOrEqual(10 * 2 * 2_000 + short.total)
  expect(tenfold.total - short.total).toBeLessThanOrEqual(10 * (rows.total - short.total) + 50)
})

it('scans the sends once when the turn opener matches none of them', async () => {
  const measure = async (sends: number) => {
    const journal = await fixture.open({
      identity: { ...fixture.IDENTITY, sessionId: `measure-${(measured += 1)}` }
    })
    for (let index = 0; index < sends; index += 1) {
      await personTurn(journal, `old-${index}`)
    }
    await limitedTurn(journal, 'unmatched', 0, { userItemId: 'provider-echo-never-attributed' })
    reads = chainReads()
    const chain = new StructuredAgentSessionJournalProjections().read(journal, null).usageLimitCut
      ?.chain
    return { chain, total: reads.total }
  }
  const few = await measure(50)
  const many = await measure(500)
  expect([few.chain, many.chain]).toEqual([0, 0])
  // Two fields of each send are compared to the opener, newest first, and nothing is read twice.
  expect(many.total).toBeLessThanOrEqual(2 * 500 + 20)
  expect(many.total - few.total).toBeLessThanOrEqual(2 * 450)
})

it('stops counting a link when its earlier usage limit is revised to another reset', async () => {
  const journal = await fixture.open()
  const projections = new StructuredAgentSessionJournalProjections()
  await chainOfOne(journal, 0)
  expect(projections.read(journal, null).usageLimitCut?.chain).toBe(1)
  // The provider rewrites the first turn's failure under the same row with a later reset.
  const first = projections.read(journal, null).usageLimitCut
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
  const revised = projections.read(journal, null).usageLimitCut
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
