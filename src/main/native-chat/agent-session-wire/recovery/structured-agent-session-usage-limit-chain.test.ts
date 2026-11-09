import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  usageLimitContinueChain,
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from './structured-agent-session-usage-limit-chain'
import {
  chainReads,
  countedItems,
  countedSubmissions
} from './structured-agent-session-usage-limit-chain-reads-test-support'

type Submission = Pick<AgentJournalSubmission, 'clientMessageId' | 'providerItemId' | 'origin'>

/** Older ordinary turns, then a usage-limited turn and `links` automatic continues that each hit it again. */
function conversation(history: number, links: number) {
  const items: AgentJournalRenderItem[] = []
  const submissions: Submission[] = []
  const push = (item: Omit<AgentJournalRenderItem, 'revision' | 'sequence' | 'observedAt'>) =>
    items.push({ ...item, revision: 0, sequence: items.length + 1, observedAt: items.length })
  const turn = (name: string, userItemId: string, resetsAt?: number) => {
    const itemId = `turn-${name}`
    push({
      itemId,
      body: {
        kind: 'turn',
        turnId: name,
        state: 'completed',
        outcome: resetsAt === undefined ? 'success' : 'failure',
        userItemId
      }
    })
    if (resetsAt !== undefined) {
      push({
        itemId: `limit-${name}`,
        turnScope: { kind: 'turn', turnItemId: itemId },
        body: {
          kind: 'status',
          ...agentSessionFailureWords(
            agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt } }),
            { surface: 'row' }
          )
        }
      })
    }
    return { turnItemId: itemId, resetsAt: resetsAt ?? 0 }
  }
  const send = (clientMessageId: string, origin: 'client' | 'host') => {
    submissions.push({ clientMessageId, providerItemId: null, origin })
    const key = agentJournalSubmissionKey(clientMessageId)
    push({ itemId: key, body: { kind: 'message', role: 'user', blocks: [] } })
    return key
  }
  for (let index = 0; index < history; index += 1) {
    turn(`old-${index}`, send(`person-${index}`, 'client'))
  }
  let cut = turn('limited', send('person-limited', 'client'), 1_000)
  for (let link = 0; link < links; link += 1) {
    const id = usageLimitContinueMessageId(link, usageLimitContinueTag(cut), '0'.repeat(16))
    cut = turn(`continued-${link}`, send(id, 'host'), 2_000 + link)
  }
  return { items, submissions, cut }
}

it('reads only the chain, never the older conversation, at N and 10N rows of history', () => {
  const measure = (history: number) => {
    const { items, submissions, cut } = conversation(history, 3)
    const reads = chainReads()
    const chain = usageLimitContinueChain(
      countedItems(items, reads),
      countedSubmissions(submissions, reads),
      cut
    )
    return { chain, reads: reads.visited.size }
  }
  const small = measure(1_000)
  const large = measure(10_000)
  expect(small.chain).toBe(3)
  expect(large.chain).toBe(3)
  // Three links of a send row, a turn and its limit row, plus the person's limited turn before them.
  expect(large.reads).toBe(small.reads)
  expect(small.reads).toBeLessThanOrEqual(40)
})

it('counts a continue across a slash-command turn run after the cut it answers', () => {
  const { items, submissions, cut } = conversation(2, 1)
  // A /compact between the person's limited turn and the automatic continue, as the latest-turn read skips it.
  const continueRow = items.findIndex((item) => item.itemId === `turn-continued-0`) - 1
  items.splice(
    continueRow,
    0,
    {
      itemId: 'command-compact',
      revision: 0,
      sequence: 0,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } }
    },
    {
      itemId: 'turn-compact',
      revision: 0,
      sequence: 0,
      observedAt: 0,
      body: {
        kind: 'turn',
        turnId: 'compact',
        state: 'completed',
        outcome: 'success',
        userItemId: 'command-compact'
      }
    }
  )
  expect(usageLimitContinueChain(items, submissions, cut)).toBe(1)
})
