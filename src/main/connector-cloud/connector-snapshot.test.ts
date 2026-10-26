import { describe, expect, it } from 'vitest'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connector-cloud-contract'
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

  it('keeps the newest maxSnapshotConversations and says it left some out', () => {
    const conversations = Array.from(
      { length: CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations + 5 },
      (_, index) => entry(String(index), NOW - index)
    )
    const { snapshot, trimmed } = connectorSnapshot({ kind: 'snapshot', conversations }, NOW)
    expect(trimmed).toBe(true)
    expect(snapshot.conversations).toHaveLength(CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations)
    expect(snapshot.conversations[0]?.paneKey).toBe('pane-0')
  })

  it('fits the event cap: prompts go unsupported first, then the least recent go', () => {
    const question = 'x'.repeat(4 * 1024)
    const conversations = Array.from(
      { length: CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations },
      (_, index) =>
        entry(String(index), NOW - index, {
          paneKey: `${index}`.padStart(128, 'p'),
          prompt: { kind: 'question', promptId: `p${index}`, question, options: [] }
        })
    )
    const { snapshot } = connectorSnapshot({ kind: 'snapshot', conversations }, NOW)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      CONNECTOR_CLIENT_LIMITS.maxEventBytes
    )
    expect(snapshot.conversations).toHaveLength(CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations)
    expect(snapshot.conversations[0]?.prompt).toEqual({ kind: 'unsupported', promptId: 'p0' })
  })

  it('leaves out the least recent when even bare entries pass the event cap', () => {
    const escaped = '\u0001'.repeat(128)
    const conversations = Array.from(
      { length: CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations },
      (_, index) =>
        entry(String(index), NOW - index, {
          conversation: { source: 'slack', externalId: `${index}${escaped}` },
          paneKey: `${index}${escaped}`
        })
    )
    const { snapshot, trimmed } = connectorSnapshot({ kind: 'snapshot', conversations }, NOW)
    expect(trimmed).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      CONNECTOR_CLIENT_LIMITS.maxEventBytes
    )
    expect(snapshot.conversations[0]?.paneKey).toBe(`0${escaped}`)
  })
})
