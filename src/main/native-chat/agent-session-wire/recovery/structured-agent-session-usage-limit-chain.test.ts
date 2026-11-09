import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  hostUsageLimitCut,
  usageLimitContinueChain,
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from './structured-agent-session-usage-limit-chain'

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

/** Counts reads of array elements, the work the derivation does per row. */
function counted<T>(values: T[], reads: { count: number }): T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads.count += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
}

it('reads only the chain, never the older conversation, at N and 10N rows of history', () => {
  const measure = (history: number) => {
    const { items, submissions, cut } = conversation(history, 3)
    const reads = { count: 0 }
    const chain = usageLimitContinueChain(counted(items, reads), counted(submissions, reads), cut)
    return { chain, reads: reads.count }
  }
  const small = measure(1_000)
  const large = measure(10_000)
  expect(small.chain).toBe(3)
  expect(large.chain).toBe(3)
  // Three links of a send row, a turn and its limit row, plus the person's limited turn before them.
  expect(large.reads).toBe(small.reads)
  expect(small.reads).toBeLessThanOrEqual(40)
})

it('rebuilding the status for the same cut reads nothing, however long its turn ran', () => {
  const measure = (outputRows: number) => {
    const { items, submissions, cut } = conversation(10, 0)
    // A person's limited turn with a long output: its chain is 0, and stays 0 for this cut.
    const limitRow = items.pop()!
    for (let index = 0; index < outputRows; index += 1) {
      items.push({
        itemId: `output-${index}`,
        revision: 0,
        sequence: items.length + 1,
        observedAt: items.length,
        turnScope: { kind: 'turn', turnItemId: cut.turnItemId },
        body: { kind: 'message', role: 'assistant', blocks: [] }
      })
    }
    items.push(limitRow)
    const first = hostUsageLimitCut({ items, submissions }, cut)
    const reads = { count: 0 }
    const rebuilt = hostUsageLimitCut(
      { items: counted(items, reads), submissions: counted(submissions, reads) },
      cut,
      first
    )
    return { chain: rebuilt?.chain, reads: reads.count }
  }
  expect(measure(1_000)).toEqual({ chain: 0, reads: 0 })
  expect(measure(10_000)).toEqual({ chain: 0, reads: 0 })
})
