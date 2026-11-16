import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'
import { connectorSnapshot } from './connector-snapshot'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

type Entry = ConversationSnapshot['conversations'][number]

function entry(id: string, activeAt: number, fields: Partial<Entry> = {}): Entry {
  return {
    conversation: { source: 'slack', externalId: `T1:C1:${id}` },
    worktreeId: 'wt',
    paneKey: `pane-${id}`,
    agent: 'claude',
    working: false,
    prompt: null,
    turnId: null,
    activeAt,
    ...fields
  }
}

const ids = (event: ConversationSnapshot) =>
  connectorSnapshot(event, NOW).snapshot.conversations.map((item) => item.paneKey)

describe('connectorSnapshot', () => {
  it('lists conversations active in the last 7 days, newest first; working counts as now', () => {
    const conversations = [
      entry('old', NOW - 8 * DAY),
      entry('recent', NOW - DAY),
      entry('newer', NOW - 1000),
      entry('busy', NOW - 30 * DAY, { working: true })
    ]
    expect(ids({ kind: 'snapshot', conversations })).toEqual([
      'pane-busy',
      'pane-newer',
      'pane-recent'
    ])
    expect(connectorSnapshot({ kind: 'snapshot', conversations }, NOW).trimmed).toBe(false)
  })
})
